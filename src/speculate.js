// Speculation gating.
//
// `ungrounded` and `trust` treat grounding as a switch: a value either carries
// the label or it does not. That is the right shape for provenance and the
// wrong one for deciding whether to answer at all, because the evidence a
// claim deserves depends on what it would cost to be wrong about it.
//
// So grounding becomes a degree, and the bar becomes a function of the domain:
//
//   C(q) = E_used / E_available        how much of the available grounding was used
//   N(q) = the time-decayed share of rejections in the region around q
//   S(q) = C(q) * (1 - N(q))           support
//
//   tau(q) = max(d(q), 1 - V(q))       the bar: what is at stake, or how badly
//                                      the claim resists being formalised
//
//   S < tau   -> refuse
//   S >= tau  -> speculate, with intensity g(S)
//
// None of S, N or tau is returned to the program. It receives the behaviour
// and nothing else, deliberately: a program that could read how close it came
// could retry until it got over the line, and a program that could branch on
// the margin would encode the bar into itself, which is precisely what the bar
// exists to stop. The numbers go into the audit record instead, where a
// reviewer can see them and the program cannot reach them.
//
// Every input is passed in. Nothing here reads a clock, a file or accumulated
// state, because a decision that depends on ambient history is a decision that
// does not replay -- and a run whose behaviour cannot be reproduced from its
// manifest is not evidence of anything. Rejection history is an argument.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// C(q). No available grounding means no support, rather than a division that
// quietly reports full coverage of nothing.
export function coverage(used, available) {
  if (!(available > 0)) return 0;
  return clamp01(used / available);
}

// N(q). Recent rejections in the region weigh more than old ones, which is the
// point of the decay: a region that used to be wrong and has since been right
// should stop being punished for it.
//
// `history` is a list of { age, rejected }. Age is in whatever unit the caller
// decays in, and only its relation to gamma matters.
export function rejectionRate(history, gamma) {
  let weighted = 0;
  let total = 0;
  for (const { age, rejected } of history) {
    const w = gamma ** age;
    total += w;
    if (rejected) weighted += w;
  }
  // An empty region is not a suspicious one. With no history there is nothing
  // to hold against the query, so N is 0 and support rests on coverage alone.
  if (total === 0) return 0;
  return clamp01(weighted / total);
}

// S(q). Coverage discounted by how often this region has been wrong lately.
export function support(c, n) {
  return clamp01(c * (1 - n));
}

// tau(q). Two independent reasons to demand more evidence, and the stricter
// one wins: the stakes are high, or the claim is hard to pin down well enough
// to check. A vague claim about something that matters needs the most.
export function threshold(stakes, formalizability) {
  return clamp01(Math.max(stakes, 1 - formalizability));
}

// g(S). How hard to speculate once the bar is cleared.
//
// The formulation leaves g open, so the default here is the identity: intensity
// is the support itself. It is a policy choice rather than something derived,
// and it is named so that changing it is a visible decision rather than a
// constant someone edits.
export function intensityOf(s) {
  return s;
}

// The whole decision, in one place, so the interpreter does not reimplement it
// and the tests have something to check that is not tangled up with builtins.
export function decide({ used, available, history = [], gamma = 0.9, stakes, formalizability }) {
  // No default for the bar. A gate that decides how much evidence a claim
  // needs cannot supply that answer itself: `stakes: 0` with
  // `formalizability: 1` puts the bar at zero, which clears everything
  // including a query with no grounding behind it at all. Whoever knows
  // the domain states the bar, or there is no decision to make.
  if (typeof stakes !== 'number' || typeof formalizability !== 'number') {
    throw new Error('a speculation decision needs both stakes and formalizability');
  }
  const c = coverage(used, available);
  const n = rejectionRate(history, gamma);
  const s = support(c, n);
  const tau = threshold(stakes, formalizability);
  const allowed = s >= tau;
  return {
    coverage: c,
    rejection: n,
    support: s,
    threshold: tau,
    allowed,
    // Refusing is a behaviour, not an absence, so it carries an intensity of
    // zero rather than nothing at all.
    intensity: allowed ? intensityOf(s) : 0,
  };
}
