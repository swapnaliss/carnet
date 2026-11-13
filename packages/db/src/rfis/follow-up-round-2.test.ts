// M3-05: how the questions of a follow-up round are classified. The wire shapes come from the recorded
// M0-04 follow-up (fixtures/airwallex/rfi-followup-fetch.json: one question reopened under its original id,
// one appended under a new id, both titled "Purpose?").
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyFollowUp, type RoundQuestionText, summariseFollowUp } from "./follow-up";

interface WireQuestion {
  id: string;
  title: { en?: string; zh?: string };
  description: { en?: string; zh?: string };
}
interface WireRfi {
  active_request: { questions: WireQuestion[] };
  answered_requests: { questions: WireQuestion[] }[];
}

const wire = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/airwallex/rfi-followup-fetch.json", import.meta.url),
    "utf8",
  ),
) as { response: { body: WireRfi } };

const text = (q: WireQuestion): RoundQuestionText => ({
  airwallexQuestionId: q.id,
  title: { en: q.title.en ?? null, zh: q.title.zh ?? null },
  description: { en: q.description.en ?? null, zh: q.description.zh ?? null },
});

const round1 = (wire.response.body.answered_requests[0]?.questions ?? []).map(text);
const round2 = wire.response.body.active_request.questions.map(text);

describe("round 2 classification on the recorded follow-up", () => {
  it("round 2: the question reopened under its original id is unchanged; the id seen for the first time is new", () => {
    const out = classifyFollowUp(round1, round2);
    expect(out.map((q) => q.kind)).toEqual(["unchanged", "new"]);
    expect(out[0]?.previous?.title).toBe("Purpose?");
    expect(out[1]?.previous).toBeNull();
  });

  it("round 2: the audit summary lists the reopened and the new question ids", () => {
    const summary = summariseFollowUp(classifyFollowUp(round1, round2));
    expect(summary.reopened).toEqual(["5f4cbf0a-ef8b-44a6-9689-247cc36caa38"]);
    expect(summary.new).toEqual(["a4f64392-f2d6-4071-8c13-70c828297792"]);
  });

  it("round 2: a reopened question with different wording is changed and keeps the old wording for the diff", () => {
    const edited = round2.map((q, i) =>
      i === 0 ? { ...q, description: { en: "Describe the purpose and the goods.", zh: null } } : q,
    );
    const out = classifyFollowUp(round1, edited);
    expect(out[0]).toMatchObject({
      kind: "changed",
      previous: { title: "Purpose?", description: "Spike question" },
    });
  });

  it("round 2: case, punctuation and spacing do not make a question changed (same normal form as the fingerprint)", () => {
    const shouted = round2.map((q, i) =>
      i === 0 ? { ...q, title: { en: "  PURPOSE ?! ", zh: null } } : q,
    );
    expect(classifyFollowUp(round1, shouted)[0]?.kind).toBe("unchanged");
  });

  it("round 3 compares against the newest earlier wording of an id", () => {
    const changed = round2.map((q, i) =>
      i === 0 ? { ...q, title: { en: "Purpose of the transfer", zh: null } } : q,
    );
    const out = classifyFollowUp([...round1, ...changed], changed);
    expect(out.map((q) => q.kind)).toEqual(["unchanged", "unchanged"]);
  });
});
