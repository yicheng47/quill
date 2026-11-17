import { describe, expect, it } from "vitest";
import { isAllowedNavigation, resolveWindowUrl } from "./urlSecurity";

describe("urlSecurity", () => {
  const devUrl = "http://localhost:1430";

  describe("resolveWindowUrl", () => {
    it("allows normal root and reader routes against dev server", () => {
      expect(resolveWindowUrl("/", devUrl)).toBe("http://localhost:1430/");
      expect(resolveWindowUrl("/reader/book-1?openChat=true&cfi=abc", devUrl)).toBe(
        "http://localhost:1430/reader/book-1?openChat=true&cfi=abc",
      );
    });

    it("allows normal root and reader routes against quill-app scheme", () => {
      expect(resolveWindowUrl("/")).toBe("quill-app://app/");
      expect(resolveWindowUrl("/reader/book-1?openVocab=true")).toBe(
        "quill-app://app/reader/book-1?openVocab=true",
      );
    });

    it("rejects protocol-relative, backslash, credential, and unknown routes", () => {
      expect(() => resolveWindowUrl("//attacker.invalid/", devUrl)).toThrow();
      expect(() => resolveWindowUrl("//attacker.invalid/")).toThrow();
      expect(() => resolveWindowUrl("/\\attacker.invalid/", devUrl)).toThrow();
      expect(() => resolveWindowUrl("https://attacker.invalid/", devUrl)).toThrow();
      expect(() => resolveWindowUrl("/unknown/page", devUrl)).toThrow();
    });
  });

  describe("isAllowedNavigation", () => {
    it("allows exact dev origin and quill-app://app only", () => {
      expect(isAllowedNavigation("http://localhost:1430/", devUrl)).toBe(true);
      expect(isAllowedNavigation("http://localhost:1430/reader/123", devUrl)).toBe(true);
      expect(isAllowedNavigation("quill-app://app/reader/123")).toBe(true);
    });

    it("rejects credential userinfo and port/domain-prefix spoofing", () => {
      expect(isAllowedNavigation("http://localhost:1430@attacker.invalid/", devUrl)).toBe(false);
      expect(isAllowedNavigation("http://user:pass@localhost:1430/", devUrl)).toBe(false);
      expect(isAllowedNavigation("http://localhost:14301/", devUrl)).toBe(false);
      expect(isAllowedNavigation("http://localhost:1430.attacker.invalid/", devUrl)).toBe(false);
      expect(isAllowedNavigation("https://localhost:1430/", devUrl)).toBe(false);
      expect(isAllowedNavigation("quill-app://evil/reader/123")).toBe(false);
      expect(isAllowedNavigation("https://example.com/", devUrl)).toBe(false);
    });
  });
});
