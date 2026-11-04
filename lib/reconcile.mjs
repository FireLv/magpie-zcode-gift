// Deciding what each account may still claim.
//
// The truth is in two responses, and neither is enough alone:
//   GET /zcode-plan/billing/preview  — the plans the server still offers this
//     account. It is EMPTY both for an account that already claimed and for
//     one that is eligible but whose claim failed (observed 2026-10-30:
//     Se Jue had an unclaimed weekend build and preview said nothing).
//   GET /zcode-plan/billing/balance  — the plans the account already holds.
//
// So the list of live batches comes from the accounts that did claim, and an
// account is "missing" a batch when its peers hold it and it does not.
//
// A batch is the date part of a plan id: zcode-v3-start-plan-1030-wk is the
// 1030 batch. Two accounts holding the same batch hold the same gift, each
// with its own user_plan_id.
// A plan id names a batch (a date) and, for a gift, a kind. The date and the
// kind are in either order and the kind may be absent:
//   zcode-v3-start-plan-1030-wk      the 1030 weekend build
//   zcode-v3-start-plan-trust-1006    the 1006 Trust Build
//   zcode-v3-start-plan-0817          the 0817 Start Plan (no kind)
const BATCH_RE = /^zcode-v3-start-plan-(?:(\d{4})(?:-([a-z]+))?|([a-z]+)-(\d{4}))$/

export const batchOf = (planId) => {
  const m = BATCH_RE.exec(planId ?? "")
  if (!m) return null
  if (m[1]) return { batch: m[1], kind: m[2] ?? "" }
  return { batch: m[4], kind: m[3] ?? "" }
}

// The plan id an account would hold for a batch. The kind suffix is what the
// server names the gift with; it is taken from a peer that holds it, so the
// id is never guessed. The server puts the kind after the date for a
// weekend build and before it for a Trust Build, so the peer's own id is
// used whenever there is one.
export const planIdFor = (batch, kind) => `zcode-v3-start-plan-${batch}${kind ? `-${kind}` : ""}`

/**
 * Plans a batch may be issued under, newest first. The server has used
 * "-wk" for a weekend build and "-trust" for a Trust Build (the plan id in
 * magpie#1001 was zcode-v3-start-plan-trust-1006), so a batch can carry
 * either.
 */
export const KINDS = ["wk", "trust"]

/**
 * What each account holds and what it is missing.
 *
 * @param {Array<{id: string, name: string, plans: Array<any>}>} accounts
 * @returns {{rows: Array<object>, batches: Array<{batch: string, kind: string, planId: string}>}}
 */
export const reconcile = (accounts) => {
  const live = new Map() // batch -> {kind, planId}
  for (const a of accounts) {
    for (const p of a.plans ?? []) {
      const b = batchOf(p.plan_id)
      if (!b) continue
      // A peer that holds it tells us the id to ask for.
      if (!live.has(b.batch)) live.set(b.batch, { kind: b.kind, planId: p.plan_id })
    }
  }
  const rows = accounts.map((a) => {
    const held = new Set()
    const heldPlans = []
    for (const p of a.plans ?? []) {
      const b = batchOf(p.plan_id)
      if (b) held.add(b.batch)
      heldPlans.push(p)
    }
    const missing = []
    for (const [batch, info] of live) {
      if (held.has(batch)) continue
      missing.push({ batch, kind: info.kind, planId: info.planId })
    }
    return { ...a, heldPlans, missing }
  })
  return { rows, batches: [...live.entries()].map(([batch, info]) => ({ batch, ...info })) }
}

/**
 * The plan id to ask for when an account is missing a batch. The batch's kind
 * is known from a peer; if the peer only showed a bare date, both kinds are
 * worth trying, the plain one first (the server answers 1001 for one it does
 * not know, so a wrong guess costs nothing but a request).
 */
export const candidatesFor = (missing, live) => {
  const known = live.find((b) => b.batch === missing.batch)
  if (known) return [known.planId]
  const kinds = missing.kind ? [missing.kind] : KINDS
  const ordered = kinds.map((k) => planIdFor(missing.batch, k))
  return [...new Set(ordered)]
}
