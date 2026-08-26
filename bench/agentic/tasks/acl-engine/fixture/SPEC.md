# ACL engine

`createAcl(roles, rules)` -> `{ check(role, action, resource) }` returning
`{ allowed, rule }`.

`roles`: `{ roleName: [parentRole, ...], ... }` — a role inherits every ancestor's
rules (multiple inheritance allowed; graph is a DAG; unknown parent: throw Error
`unknown role <name>` at create time, first offender by child role name alphabetical,
then parent order as listed).

`rules`: array of `{ id, role, effect: 'allow'|'deny', action, resource }` where
`action` is a literal or `*`, and `resource` is a path like `repo/docs/readme` where
each segment is a literal or `*`, plus an optional trailing `/**` matching any suffix
(including none). Examples: `repo/*/readme`, `repo/**`, `**`.

`check(role, action, resource)`:
- Unknown role: throw Error `unknown role <role>`.
- Applicable rules: rules whose role is the checked role or any ancestor, whose action
  matches, and whose resource pattern matches.
- Decision: if ANY applicable rule is a deny -> denied by the MOST SPECIFIC deny;
  else if any allow -> allowed by the most specific allow; else `{ allowed: false,
  rule: null }` (default deny).
- Specificity: more literal segments (counting `/**` as zero and each `*` as zero)
  wins; tie -> longer pattern (more segments, `/**` counting as one) wins; still tied
  -> rule earliest in the rules array wins.
- The returned `rule` is the winning rule's `id` (null for default deny).
