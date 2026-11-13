// The harness needs a key present even when every request is replayed by a test transport. Kept out of
// packages/agent/src so the boundary test (the key is read in one module only) stays true.
process.env.ANTHROPIC_API_KEY ||= "test-not-a-key";
