# CONCLUSIONS.md — research conclusions

> What it is: the conclusions of an **inline research** activity, written into the active session (`refine`/`exec`/`quick`). Produced when the research concludes (success or `inconclusive`). The parent loop reads this to resolve the gap that triggered the research.

## Conclusion
Direct answer to the initial question.

## Recommended Action
Example:
- [ ] Fix code
- [ ] Open follow-up task
- [ ] Update docs
- [ ] Defer (insufficient evidence)
- [ ] No action

## Details
Supporting detail, evidence references, or additional context.

## Remote context (only when captured)

For each read-only remote investigation, record the matching `RemoteContextSnapshot` from
`SCRIPTS.sql`: connection, query artifact, capture time and result digest. It is research context
with no automatic expiry; refreshing it requires a plan/spec refine. It is never copied into a
task, validation, exit condition or closure claim.
