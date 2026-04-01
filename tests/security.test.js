const { sanitizeForAI } = require('../src/services/aiService');
const { xssSanitizerREST } = require('../src/middleware/xssSanitizer');
const httpMocks = require('node-mocks-http');

describe('Security & Privacy Components', () => {

  describe('AI Privacy Guard', () => {
    it('should redact email addresses', () => {
      const input = "Hey, my email is user@example.com please hit me up!";
      const output = sanitizeForAI(input);
      expect(output).toBe("Hey, my email is [EMAIL] please hit me up!");
    });

    it('should redact consecutive digit strings (e.g. phone numbers)', () => {
      const input = "Call me at 9876543210 tomorrow.";
      const output = sanitizeForAI(input);
      expect(output).toBe("Call me at [NUMBER] tomorrow.");
    });
  });

  describe('XSS Sanitization Middleware', () => {
    it('should strip script tags from request body', () => {
      const req = httpMocks.createRequest({
        body: {
          message: "<script>alert('hacked')</script>Hello",
          nested: {
            field: "<b onmouseover=alert(1)>bold</b>"
          }
        }
      });
      const res = httpMocks.createResponse();
      const next = jest.fn();

      xssSanitizerREST(req, res, next);

      // xss module escapes tags
      expect(req.body.message).not.toContain('<script>');
      expect(req.body.message).toContain('&lt;script&gt;');
      expect(req.body.nested.field).not.toContain('onmouseover');
      expect(next).toHaveBeenCalled();
    });
  });

});
