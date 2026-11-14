# M3-03 live proof (Airwallex sandbox)

Recorded 2026-11-14T15:31:57.648Z against the sandbox. Sandbox keys only; no secret appears here.

## Conversion under policy
- plan action: 2a59443f-12cd-4490-bb2c-bd7b0db041ae
- policy version 1, hash 2147bbc580b74046e85062f5af5cb6b453e8f437b59a50abccf83e4db0a543d3
- auto_approvals row: da3e2c97-457a-4252-b3e1-ca81a21a51c1, amount 100 USD, daily total after 100
- attempt c5f046ce-b9ef-4d44-8f63-281cda77960c: request_id 97dd8c20-f4bd-4021-98e8-0d38cb244534, status CONFIRMED
- Airwallex conversion id 6c6263b7-48d3-4c2f-b837-3d07cf90b083, status SETTLED

## Payout after a bound approval
- payment: 07fb8219-14d1-4f06-afd0-148da9063270, beneficiary 9201f6be-23cd-45b0-a375-cfbe173e0a00
- approval be1a740f-04f2-4e7f-9b0b-336835ce84db: hash 111021f23cbbe647c5cfc8189787c8cbc1b7fbc517667288d33ce8480700ab08, status CONSUMED
- attempt c52c5d47-87e3-48ef-99f1-5b83a14a2753: request_id efda006b-8872-49e3-8cca-68ef900779ec, status CONFIRMED
- Airwallex transfer id fa3bb24f-c10b-4c8e-86b4-19fabd36acca, status SCHEDULED

## Fixtures
9 calls recorded under fixtures/airwallex/m3/ (login excluded).

## Differences from the recorded M0 behaviour
- The sandbox USD to EUR rate had moved more than the policy's 100 bps slippage bound from the rate recorded on 2026-11-11, so the first live attempts were refused with `SLIPPAGE` before any conversion. The live test now plans from a fresh USD 100.00 probe quote (never converted). This confirms the slippage guard works against a real rate; it is not a sandbox difference.
- The payout transfer was `SCHEDULED` when created. It was not followed to a final status in this run (`SENT` and `PAID` are not final; `PAID` can still fail).
- The test file ran under two vitest projects (unit and db), so the sandbox saw two runs of the proof; the ids above and the fixtures are from one of them. A third conversion (USD 1.00) was made by an earlier attempt that stopped on a test-side serialisation error. Total live spend: a few USD 1.00 conversions and payouts, sandbox funds only.
- Not verified here: quote single-use behaviour beyond M0-03, and webhook delivery for these objects.
