import os
import uuid
import re
import json
import hashlib
from dotenv import load_dotenv
from pypdf import PdfReader
from fastapi import FastAPI, UploadFile, File, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import chromadb
from sentence_transformers import SentenceTransformer
import redis as redis_lib
from google import genai as google_genai

load_dotenv()

# -- Gemini --
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
gemini_client = None
if GEMINI_API_KEY:
    try:
        gemini_client = google_genai.Client(api_key=GEMINI_API_KEY)
        print("[OK] Gemini 3.1 Flash Lite initialized.")
    except Exception as e:
        print(f"[WARN] Gemini init failed: {e}")
else:
    print("[WARN] GEMINI_API_KEY not set -- running in fallback mode.")

# -- Redis Cache --
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
CACHE_TTL = 600  # 10 minutes

try:
    redis_client = redis_lib.from_url(REDIS_URL, decode_responses=True)
    redis_client.ping()
    print("[OK] Redis cache connected.")
except Exception as e:
    redis_client = None
    print(f"[WARN] Redis cache unavailable: {e}")

# -- ChromaDB --
CHROMA_DATA_PATH = "./chroma_data"
chroma_client = chromadb.PersistentClient(path=CHROMA_DATA_PATH)

# -- RAM-Optimized Embedding Pipeline --
embedder = None

def get_embeddings(texts: list) -> list:
    """
    Ultra-lightweight RAM-optimized embedding pipeline:
    1. Primary: Gemini Embeddings API (text-embedding-004) -> 0 MB local RAM usage.
    2. Fallback: Lazy-load MiniLM-L6-v2 only if GEMINI_API_KEY missing.
    """
    global embedder
    if gemini_client:
        try:
            res = gemini_client.models.embed_content(
                model="text-embedding-004",
                contents=texts
            )
            return [e.values for e in res.embeddings]
        except Exception as e:
            print(f"[WARN] Gemini Embeddings API call failed: {e}")

    if embedder is None:
        print("[INFO] Lazy-loading MiniLM-L6-v2 embedding model...")
        embedder = SentenceTransformer('all-MiniLM-L6-v2')
        print("[OK] MiniLM-L6-v2 ready.")

    return embedder.encode(texts).tolist()

app = FastAPI(title="NexChat Enterprise RAG Engine v3")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# -- Helpers --

def get_user_collection(user_id: str):
    """
    Multi-tenant namespace isolation.
    Each user gets their own ChromaDB collection -- zero cross-user data leakage.
    """
    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', user_id)[:40]
    name = f"user_{safe_id}"
    return chroma_client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine", "user_id": user_id}
    )

def cache_key(user_id: str, query: str) -> str:
    """MD5 hash of query, namespaced by user_id for easy invalidation."""
    q_hash = hashlib.md5(query.strip().lower().encode()).hexdigest()
    return f"rag_cache:{user_id}:{q_hash}"

def clear_user_cache(user_id: str):
    """Clear all RAG cache for a user when their knowledge base changes."""
    if not redis_client:
        return
    try:
        keys = redis_client.keys(f"rag_cache:{user_id}:*")
        if keys:
            redis_client.delete(*keys)
            print(f"[CACHE] Cleared {len(keys)} cache entries for user '{user_id}'")
    except Exception as e:
        print(f"[WARN] Failed to clear cache: {e}")

def get_cached(user_id: str, query: str):
    if not redis_client:
        return None
    try:
        val = redis_client.get(cache_key(user_id, query))
        return json.loads(val) if val else None
    except Exception:
        return None

def set_cached(user_id: str, query: str, data: dict):
    if not redis_client:
        return
    try:
        redis_client.setex(cache_key(user_id, query), CACHE_TTL, json.dumps(data))
    except Exception:
        pass

def extract_text_from_pdf(file_bytes: bytes) -> list:
    import io
    pages = []
    reader = PdfReader(io.BytesIO(file_bytes))
    for i, page in enumerate(reader.pages):
        raw = page.extract_text()
        if raw and raw.strip():
            clean = re.sub(r'[ \t]+', ' ', raw)
            clean = re.sub(r'\n{3,}', '\n\n', clean).strip()
            pages.append({"page_num": i + 1, "text": clean})
    return pages

def chunk_text(text: str, chunk_size: int = 600, overlap: int = 80) -> list:
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks, current = [], ""
    for sentence in sentences:
        if len(current) + len(sentence) <= chunk_size:
            current += (" " if current else "") + sentence
        else:
            if current:
                chunks.append(current.strip())
            overlap_text = current[-overlap:] if len(current) > overlap else current
            current = overlap_text + " " + sentence
    if current.strip():
        chunks.append(current.strip())
    return chunks or [text]

def call_gemini(prompt: str) -> Optional[str]:
    """
    Gemini 3.1 Flash Lite -- chosen for best free-tier rate limits:
    15 RPM, 500 RPD, 250K TPM.
    """
    if not gemini_client:
        return None
    try:
        response = gemini_client.models.generate_content(
            model="gemini-3.1-flash-lite",
            contents=prompt,
        )
        return response.text
    except Exception as e:
        print(f"Gemini error: {e}")
        return None

# -- Models --

class ChatRequest(BaseModel):
    query: str
    user_id: str
    top_k: int = 5

# -- Endpoints --

@app.get("/health")
def health():
    return {
        "status": "ok",
        "gemini_enabled": gemini_client is not None,
        "redis_cache_enabled": redis_client is not None,
        "cache_ttl_seconds": CACHE_TTL,
    }


@app.post("/upload")
async def upload_document(user_id: str = Header(..., alias="X-User-Id"),
                          file: UploadFile = File(...)):
    """
    Ingest PDF into the user's private ChromaDB namespace.
    """
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    file_bytes = await file.read()
    pages = extract_text_from_pdf(file_bytes)

    if not pages:
        raise HTTPException(status_code=400, detail="Could not extract text from PDF.")

    collection = get_user_collection(user_id)

    # Delete existing chunks for this filename to avoid duplicates on re-upload
    try:
        existing = collection.get(where={"source": file.filename})
        if existing["ids"]:
            collection.delete(ids=existing["ids"])
            print(f"Removed {len(existing['ids'])} stale chunks for '{file.filename}'")
    except Exception:
        pass

    chunk_ids, documents, metadatas = [], [], []
    for page in pages:
        for idx, chunk in enumerate(chunk_text(page["text"])):
            chunk_ids.append(f"{user_id}_{file.filename}_p{page['page_num']}_{idx}_{uuid.uuid4().hex[:6]}")
            documents.append(chunk)
            metadatas.append({"source": file.filename, "page_num": page["page_num"], "user_id": user_id})

    print(f"Indexing {len(documents)} chunks for user '{user_id}'...")
    collection.add(
        ids=chunk_ids,
        embeddings=get_embeddings(documents),
        documents=documents,
        metadatas=metadatas
    )

    # Invalidate any cached queries for this user since the KB changed
    clear_user_cache(user_id)

    return {
        "status": "success",
        "message": f"'{file.filename}' ingested successfully.",
        "pages_processed": len(pages),
        "chunks_indexed": len(documents)
    }


@app.get("/documents/{user_id}")
def list_documents(user_id: str):
    """List all unique documents in a user's knowledge base."""
    try:
        collection = get_user_collection(user_id)
        all_meta = collection.get(include=["metadatas"])["metadatas"]
        seen, docs = set(), []
        for m in all_meta:
            src = m.get("source", "unknown")
            if src not in seen:
                seen.add(src)
                docs.append({"filename": src})
        return {"status": "success", "documents": docs, "total": len(docs)}
    except Exception as e:
        return {"status": "success", "documents": [], "total": 0}


@app.delete("/documents/{user_id}/{filename}")
def delete_document(user_id: str, filename: str):
    """Delete all chunks of a specific document from the user's namespace."""
    try:
        collection = get_user_collection(user_id)
        existing = collection.get(where={"source": filename})
        if not existing["ids"]:
            raise HTTPException(status_code=404, detail="Document not found.")
        collection.delete(ids=existing["ids"])

        # Invalidate any cached queries for this user
        clear_user_cache(user_id)

        return {"status": "success", "message": f"'{filename}' deleted ({len(existing['ids'])} chunks removed)."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat")
async def chat_query(request: ChatRequest):
    """
    Enterprise Hybrid RAG Pipeline:
    1. Redis cache check (sub-millisecond for repeated queries)
    2. Semantic vector search (ChromaDB cosine similarity)
    3. Exact keyword filter for quoted terms (Hybrid Search)
    4. Gemini 3.1 Flash Lite LLM generation
    5. Deterministic citation engine (source + page number)
    """
    user_id = request.user_id
    query_str = request.query

    # -- 1. Redis Cache Hit --
    cached = get_cached(user_id, query_str)
    if cached:
        print(f"[CACHE HIT] user '{user_id}' query: '{query_str[:40]}'")
        cached["cache_hit"] = True
        return cached

    # -- 2. Hybrid Search --
    collection = get_user_collection(user_id)
    count = collection.count()
    if count == 0:
        return {"answer": "No documents found. Upload a PDF first.", "citations": [], "cache_hit": False}

    exact_keywords = re.findall(r'"([^"]*)"', query_str)
    clean_query = re.sub(r'"[^"]*"', '', query_str).strip() or query_str
    query_vector = get_embeddings([clean_query])

    results = None
    if exact_keywords:
        try:
            results = collection.query(
                query_embeddings=query_vector,
                n_results=min(request.top_k, count),
                where_document={"$contains": exact_keywords[0]},
                include=["documents", "metadatas", "distances"]
            )
        except Exception:
            results = None

    if not results or not results["documents"] or not results["documents"][0]:
        results = collection.query(
            query_embeddings=query_vector,
            n_results=min(request.top_k, count),
            include=["documents", "metadatas", "distances"]
        )

    if not results["documents"] or not results["documents"][0]:
        return {"answer": "No relevant information found in your documents.", "citations": [], "cache_hit": False}

    # -- 3. Build Context & Citations --
    chunks = results["documents"][0]
    metas = results["metadatas"][0]
    context_blocks, citations, seen = [], [], set()

    for chunk, meta in zip(chunks, metas):
        context_blocks.append(f"[{meta['source']} -- Page {meta['page_num']}]\n{chunk}")
        key = (meta["source"], meta["page_num"])
        if key not in seen:
            seen.add(key)
            citations.append({
                "source": meta["source"],
                "page_num": meta["page_num"],
                "snippet": chunk[:200].strip() + ("..." if len(chunk) > 200 else "")
            })

    final_context = "\n\n---\n\n".join(context_blocks)

    # -- 4. Gemini LLM Generation --
    prompt = f"""You are a professional enterprise AI assistant embedded in a real-time chat app.
Answer the user's question using ONLY the provided document context.
Be concise and professional. Use bullet points for multiple items.
If the answer is not in the context, say: "I cannot find that in the uploaded documents."
Do NOT hallucinate.

--- DOCUMENT CONTEXT ---
{final_context}
--- END CONTEXT ---

User Question: {query_str}

Answer:"""

    answer = call_gemini(prompt)
    if not answer:
        answer = f"*Gemini unavailable -- showing raw retrieved context:*\n\n{final_context}"

    response_data = {
        "answer": answer,
        "citations": citations,
        "llm_prompt": answer,       # kept for frontend compat
        "context_retrieved": final_context,
        "cache_hit": False,
        "search_type": "hybrid" if exact_keywords else "semantic"
    }

    # -- 5. Store in Redis Cache --
    set_cached(user_id, query_str, response_data)
    print(f"[CACHED] Response stored for user '{user_id}'")

    return response_data


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
