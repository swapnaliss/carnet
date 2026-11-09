// M2-07 AC 1: the approval hash is deterministic and covers every field of the subject. One test per
// field: changing it (by one character where it is text) changes the hash.
import { describe, expect, it } from "vitest";
import {
  APPROVAL_EXPIRY_MARGIN_MS,
  type ApprovalSubject,
  approvalCanonicalJson,
  approvalExpiry,
  approvalHash,
  approvalQuestionText,
  type BusinessId,
  CanonicalJsonError,
  canTransitionApproval,
  hashMatches,
  type UserId,
} from "../src/index";

const subject = (): ApprovalSubject => ({
  kind: "rfi_answer",
  businessId: "11111111-1111-4111-8111-111111111111" as BusinessId,
  approverId: "22222222-2222-4222-8222-222222222222" as UserId,
  nonce: "nonce-aaaaaaaaaaaaaaaa",
  rfiId: "33333333-3333-4333-8333-333333333333",
  rfiUpdatedAt: "2026-11-03T09:57:38.000Z",
  draftId: "44444444-4444-4444-8444-444444444444",
  promptVersion: "draft@2026-11-05.1",
  questions: [
    { id: "q-1", text: "Provide the invoice\nFor transfer 123" },
    { id: "q-2", text: "Describe the purpose" },
  ],
  answers: [
    {
      questionId: "q-1",
      type: "ATTACHMENT",
      text: "",
      attachments: [{ documentId: "doc-1", sha256: "a".repeat(64) }],
      factVersionIds: ["fv-1"],
    },
    {
      questionId: "q-2",
      type: "TEXT",
      text: "Payment for professional services under contract C-7.",
      attachments: [],
      factVersionIds: ["fv-2", "fv-3"],
    },
  ],
});

const base = approvalHash(subject());

type Mutator = [string, (s: ApprovalSubject) => ApprovalSubject];
const MUTATIONS: Mutator[] = [
  ["business", (s) => ({ ...s, businessId: "11111111-1111-4111-8111-111111111112" as BusinessId })],
  ["approver", (s) => ({ ...s, approverId: "22222222-2222-4222-8222-222222222223" as UserId })],
  ["nonce", (s) => ({ ...s, nonce: "nonce-aaaaaaaaaaaaaaab" })],
  ["rfi id", (s) => ({ ...s, rfiId: "33333333-3333-4333-8333-333333333334" })],
  ["RFI updated_at", (s) => ({ ...s, rfiUpdatedAt: "2026-11-03T09:57:39.000Z" })],
  [
    "question id",
    (s) => ({
      ...s,
      questions: [{ id: "q-9", text: s.questions[0]?.text ?? "" }, ...s.questions.slice(1)],
    }),
  ],
  [
    "question text (one character)",
    (s) => ({
      ...s,
      questions: [
        { id: "q-1", text: "Provide the invoice\nFor transfer 124" },
        ...s.questions.slice(1),
      ],
    }),
  ],
  [
    "answer text (one character)",
    (s) => ({
      ...s,
      answers: [
        ...s.answers.slice(0, 1),
        {
          ...(s.answers[1] as ApprovalSubject["answers"][number]),
          text: "Payment for professional services under contract C-8.",
        },
      ],
    }),
  ],
  [
    "attachment document id",
    (s) => ({
      ...s,
      answers: [
        {
          ...(s.answers[0] as ApprovalSubject["answers"][number]),
          attachments: [{ documentId: "doc-2", sha256: "a".repeat(64) }],
        },
        ...s.answers.slice(1),
      ],
    }),
  ],
  [
    "attachment sha256 (one character)",
    (s) => ({
      ...s,
      answers: [
        {
          ...(s.answers[0] as ApprovalSubject["answers"][number]),
          attachments: [{ documentId: "doc-1", sha256: `${"a".repeat(63)}b` }],
        },
        ...s.answers.slice(1),
      ],
    }),
  ],
  [
    "fact version id",
    (s) => ({
      ...s,
      answers: [
        { ...(s.answers[0] as ApprovalSubject["answers"][number]), factVersionIds: ["fv-9"] },
        ...s.answers.slice(1),
      ],
    }),
  ],
  ["draft id", (s) => ({ ...s, draftId: "44444444-4444-4444-8444-444444444445" })],
  ["prompt version", (s) => ({ ...s, promptVersion: "draft@2026-11-05.2" })],
  [
    "answer type",
    (s) => ({
      ...s,
      answers: [
        { ...(s.answers[0] as ApprovalSubject["answers"][number]), type: "TEXT" },
        ...s.answers.slice(1),
      ],
    }),
  ],
  [
    "answer's question id",
    (s) => ({
      ...s,
      answers: [
        { ...(s.answers[0] as ApprovalSubject["answers"][number]), questionId: "q-2" },
        ...s.answers.slice(1),
      ],
    }),
  ],
];

describe("approval hash", () => {
  it("is a lower-case SHA-256 hex string and identical across runs and key order", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalHash(subject())).toBe(base);
    const s = subject();
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as unknown as ApprovalSubject;
    expect(approvalHash(reordered)).toBe(base);
    expect(hashMatches(base, reordered)).toBe(true);
  });

  it.each(MUTATIONS)("changing the %s changes the hash", (_name, mutate) => {
    const changed = approvalHash(mutate(subject()));
    expect(changed).not.toBe(base);
    expect(hashMatches(base, mutate(subject()))).toBe(false);
  });

  it("covers every top-level field of the subject (a new field must be added to the mutations)", () => {
    const covered = new Set(Object.keys(subject()));
    expect([...covered].sort()).toEqual(
      [
        "answers",
        "approverId",
        "businessId",
        "draftId",
        "kind",
        "nonce",
        "promptVersion",
        "questions",
        "rfiId",
        "rfiUpdatedAt",
      ].sort(),
    );
  });

  it("treats a decomposed and a composed string as the same text (NFC)", () => {
    const composed = subject();
    const decomposed: ApprovalSubject = {
      ...composed,
      questions: [{ id: "q-1", text: "Café" }, ...composed.questions.slice(1)],
    };
    const normal: ApprovalSubject = {
      ...composed,
      questions: [{ id: "q-1", text: "Café" }, ...composed.questions.slice(1)],
    };
    expect(approvalHash(decomposed)).toBe(approvalHash(normal));
  });
});

describe("approval canonical JSON", () => {
  it("sorts keys, drops whitespace and normalises to NFC", () => {
    expect(approvalCanonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: "é" } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":"é","z":0}}',
    );
  });
  it("refuses floats, NaN, bigint, undefined and duplicate keys after normalisation", () => {
    expect(() => approvalCanonicalJson({ a: 1.5 })).toThrow(CanonicalJsonError);
    expect(() => approvalCanonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => approvalCanonicalJson({ a: 1n })).toThrow(CanonicalJsonError);
    expect(() => approvalCanonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => approvalCanonicalJson({ é: 1, é: 2 })).toThrow(CanonicalJsonError);
  });
});

describe("approval TTL and state", () => {
  const now = new Date("2026-11-05T10:00:00Z");
  it("is now plus the TTL, capped at the RFI expiry minus the margin", () => {
    expect(approvalExpiry({ now, ttlMinutes: 30, rfiExpiresAt: null })).toEqual(
      new Date("2026-11-05T10:30:00Z"),
    );
    expect(
      approvalExpiry({ now, ttlMinutes: 30, rfiExpiresAt: new Date("2026-11-06T10:00:00Z") }),
    ).toEqual(new Date("2026-11-05T10:30:00Z"));
    const rfiExpiresAt = new Date("2026-11-05T10:20:00Z");
    expect(approvalExpiry({ now, ttlMinutes: 30, rfiExpiresAt })).toEqual(
      new Date(rfiExpiresAt.getTime() - APPROVAL_EXPIRY_MARGIN_MS),
    );
  });
  it("is null when the RFI is too close to expiry", () => {
    expect(
      approvalExpiry({ now, ttlMinutes: 30, rfiExpiresAt: new Date("2026-11-05T10:05:00Z") }),
    ).toBeNull();
    expect(
      approvalExpiry({ now, ttlMinutes: 30, rfiExpiresAt: new Date("2026-11-05T09:00:00Z") }),
    ).toBeNull();
  });
  it("only allows the documented approval edges", () => {
    expect(canTransitionApproval("APPROVED", "CONSUMED")).toBe(true);
    expect(canTransitionApproval("PENDING", "APPROVED")).toBe(true);
    expect(canTransitionApproval("CONSUMED", "APPROVED")).toBe(false);
    expect(canTransitionApproval("EXPIRED", "CONSUMED")).toBe(false);
    expect(canTransitionApproval("REJECTED", "APPROVED")).toBe(false);
  });
  it("renders question text from title and description", () => {
    expect(approvalQuestionText({ en: "T", zh: null }, { en: "D", zh: null })).toBe("T\nD");
    expect(approvalQuestionText({ en: null, zh: "标题" }, { en: null, zh: null })).toBe("标题");
  });
});
