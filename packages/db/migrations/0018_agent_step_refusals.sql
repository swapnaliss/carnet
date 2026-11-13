-- M4-02: a model call refused before the network by the kill switch or a spend cap is recorded as a
-- step (outcome killed / spend_cap, zero tokens, zero cost).
ALTER TABLE "agent_steps" DROP CONSTRAINT "agent_steps_outcome_check";
--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_outcome_check" CHECK ("outcome" IN ('ok', 'refused', 'truncated', 'provider_error', 'killed', 'spend_cap'));
