# Drafting rules

`apimigrate draft old.json new.json` compares two OpenAPI 3.x specs and drafts a rule file for a publisher to review. It is a starting point. It never produces a rule that can be signed as it stands.

```sh
node bin/apimigrate.js draft old.json new.json --provider acme --package acme-sdk --from 1 --to 2 --naming underscore --out draft-rules.json
```

It writes the rule file and a `draft-rules.report.json` beside it. Specs must be JSON. YAML is rejected with a message. Swagger 2 is rejected.

## What it detects

| Change | Result |
| --- | --- |
| Same method and route with a new `operationId`, one old and one new | A `rename-method` rule. |
| Only one unmatched old and one unmatched new operation with the same HTTP method | A `rename-method` rule marked as a guess. |
| Same `operationId`, different path | Listed in the report. No code rule, because the SDK method did not change. |
| Parameter or body field renamed, with the same location and type, one removed and one added | A `rename-param` rule. |
| Operation, parameter or field with no counterpart | A `manual` rule with a prompt. |
| New required parameter or field | A `manual` rule. |
| Changed type, format, enum or nullability | A `manual` rule that names both types. |
| Response field removed or changed | A `manual` rule. |

References such as `$ref` and `allOf` are resolved inside the document. Cycles and dangling references are treated as empty. `oneOf` and `anyOf` are treated as opaque.

## Confidence

Every rule carries `confidence` and `evidence`. The draft never says a rule is certain.

- `likely` means the evidence is structural and one to one, and the publisher stated the naming convention with `--naming`.
- `needs-review` means anything else. Without `--naming`, every method rename is `needs-review`, because the SDK method name is an assumption about how the generator names methods. Non-body parameter renames are always `needs-review`, because many SDKs take them as positional arguments.

`--naming underscore` maps `charges_create` to `charges.create`. `--naming identity` uses the `operationId` as the call.

## Before signing

`sign` refuses a file with `draft: true` or any `confidence` field. The publisher reads each rule, checks it against the real SDK, fixes it, and removes the marks. `lint` reports what still blocks signing.

## Limits

- It cannot know how a given SDK generator names things. That is why the naming flag exists.
- Operations are matched by `operationId` or by method and route. Heavy restructuring will show up as removals and additions.
- Only the first 2xx response and the JSON request body are compared. Other media types are compared only if they are the first listed.
- It does not see behavior changes that the spec does not describe.

Related docs are [rule format](rule-format.md), [CLI reference](cli.md) and [matching](matching.md).
