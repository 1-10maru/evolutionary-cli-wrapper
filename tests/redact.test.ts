import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretText } from "../src/redact";

describe("redactSecrets — assignment patterns (shared with evo logs --bundle)", () => {
  it("masks JSON-style secret values", () => {
    expect(redactSecrets('{"API_TOKEN":"abc123"}')).toBe('{"API_TOKEN":"[REDACTED]"}');
  });

  it("masks quoted bare assignments including multi-word values", () => {
    expect(redactSecrets('MY_SECRET="a b c"')).toBe('MY_SECRET="[REDACTED]"');
  });

  it("masks unquoted assignments", () => {
    expect(redactSecrets("PASSWORD=hunter2")).toBe("PASSWORD=[REDACTED]");
    expect(redactSecrets("AWS_SECRET_KEY: xyz")).toBe("AWS_SECRET_KEY: [REDACTED]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("please fix the login button")).toBe("please fix the login button");
  });

  it("is idempotent", () => {
    const once = redactSecrets('TOKEN="value"');
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("redactSecretText — standalone credential shapes", () => {
  // Fixtures are built from string parts so no scannable credential literal
  // ever appears in source (GitHub push protection flags contiguous tokens).
  it("masks AWS access key IDs", () => {
    const akia = "AKIA" + "IOSFODNN7EXAMPLE";
    const asia = "ASIA" + "IOSFODNN7EXAMPLE";
    expect(redactSecretText(`key is ${akia} here`)).toBe("key is [REDACTED] here");
    expect(redactSecretText(asia)).toBe("[REDACTED]");
  });

  it("masks GitHub tokens", () => {
    const t = "ghp_" + "A".repeat(36);
    expect(redactSecretText(`token ${t}`)).toBe("token [REDACTED]");
  });

  it("masks sk-, sk-ant-, sk-proj-, sk-svcacct- API keys (real, long bodies)", () => {
    expect(redactSecretText("sk-ant-api03-" + "a".repeat(40))).toBe("[REDACTED]");
    expect(redactSecretText("use sk-" + "b".repeat(48) + " now")).toBe("use [REDACTED] now");
    expect(redactSecretText("sk-proj-" + "c".repeat(30))).toBe("[REDACTED]");
    expect(redactSecretText("sk-svcacct-" + "d".repeat(30))).toBe("[REDACTED]");
  });

  it("does NOT mask short benign sk- words (tightened body length)", () => {
    // Bodies under the 24-char minimum are ordinary words, not keys.
    for (const benign of ["sk-cli", "sk-based", "sk-based-tool", "use the sk-lang here"]) {
      expect(redactSecretText(benign)).toBe(benign);
    }
  });

  it("masks Google API keys and Slack tokens", () => {
    expect(redactSecretText("AIza" + "b".repeat(35))).toBe("[REDACTED]");
    const slack = "xoxb-" + "123456789012-abcdefghijklmnop";
    expect(redactSecretText(slack)).toBe("[REDACTED]");
  });

  it("masks Bearer tokens but keeps the marker", () => {
    expect(redactSecretText("Authorization: Bearer " + "x".repeat(40))).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("masks PEM private-key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----";
    expect(redactSecretText(`here: ${pem}`)).toBe("here: [REDACTED]");
  });

  it("also applies the assignment patterns", () => {
    expect(redactSecretText('config GITHUB_TOKEN="abc def"')).toBe(
      'config GITHUB_TOKEN="[REDACTED]"',
    );
  });

  it("does not mask ordinary prose (no false positives)", () => {
    const prose =
      "refactor the parser and add a test for the tokenizer; the sky is blue";
    expect(redactSecretText(prose)).toBe(prose);
  });

  it("returns empty/undefined-safe values unchanged", () => {
    expect(redactSecretText("")).toBe("");
  });
});
