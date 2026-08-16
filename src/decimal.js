import { NativeFunction } from './values.js';
import { pedagError } from './errors.js';

const nf = (name, arity, fn) => new NativeFunction(name, arity, fn);

// Exact decimal arithmetic.
//
// `num` is a 64-bit float. It cannot hold 0.1, so ten additions of 0.1 do not
// make 1, and no amount of care at the call site fixes that. For money, for
// settlement, for anything that has to reconcile, the representation has to be
// exact — so this is a separate type, not a flag on the old one.
//
// A Decimal is an integer coefficient and a scale: 12.50 is 1250 at scale 2.
// The coefficient is a BigInt, so there is no upper bound and no rounding you
// did not ask for.
//
//     let price = dec("12.50")
//     let total = price * 3          -> 37.50, exactly
//
// Decimals do not mix with `num` implicitly. That refusal is the feature: a
// float silently entering a monetary calculation is exactly the bug this type
// exists to prevent, so crossing between them has to be written down.

const POW10 = [];
for (let i = 0; i <= 64; i++) POW10.push(10n ** BigInt(i));
const pow10 = (n) => (n < POW10.length ? POW10[n] : 10n ** BigInt(n));

export const MAX_SCALE = 34;          // more than money or rates ever need

export class Decimal {
  constructor(coefficient, scale) {
    this.c = coefficient;             // BigInt
    this.scale = scale;               // digits after the point
  }
  get pedagType() { return 'dec'; }

  static parse(text, line = null) {
    const s = String(text).trim();
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
      throw pedagError('ValueError', `\`${s}\` is not a decimal number`, line)
        .help('write it as text, for example dec("12.50")');
    }
    const [, sign, whole, frac = '', exp] = m;
    let scale = frac.length;
    let coefficient = BigInt((whole || '0') + frac);
    if (exp) {
      const e = Number(exp);
      if (e >= 0) {
        if (e > scale) { coefficient *= pow10(e - scale); scale = 0; } else scale -= e;
      } else {
        scale += -e;
      }
    }
    if (scale > MAX_SCALE) {
      throw pedagError('ValueError',
        `a decimal may carry at most ${MAX_SCALE} digits after the point, this has ${scale}`, line);
    }
    return new Decimal(sign === '-' ? -coefficient : coefficient, scale);
  }

  // From a whole number only. Converting a float would import the very
  // imprecision the type exists to keep out.
  static fromInteger(n, line = null) {
    if (!Number.isInteger(n)) {
      throw pedagError('TypeError',
        `\`${n}\` is a float, and converting it would carry its imprecision into exact arithmetic`, line)
        .help('write the exact value as text instead, for example dec("0.1")');
    }
    if (!Number.isSafeInteger(n)) {
      throw pedagError('ValueError', `\`${n}\` is beyond what a num holds exactly`, line);
    }
    return new Decimal(BigInt(n), 0);
  }

  // Line the two up on the same scale so they can be compared or added.
  static align(a, b) {
    if (a.scale === b.scale) return [a.c, b.c, a.scale];
    const scale = Math.max(a.scale, b.scale);
    return [a.c * pow10(scale - a.scale), b.c * pow10(scale - b.scale), scale];
  }

  add(other) {
    const [x, y, scale] = Decimal.align(this, other);
    return new Decimal(x + y, scale);
  }

  sub(other) {
    const [x, y, scale] = Decimal.align(this, other);
    return new Decimal(x - y, scale);
  }

  mul(other) {
    const scale = this.scale + other.scale;
    const product = new Decimal(this.c * other.c, Math.min(scale, MAX_SCALE));
    return scale > MAX_SCALE ? product.rescale(MAX_SCALE) : product;
  }

  // Division cannot always be exact, so it says what it did: the result carries
  // `scale` digits, rounded half-to-even, which is the rounding financial
  // reporting expects.
  div(other, scale, line = null) {
    if (other.c === 0n) throw pedagError('ZeroDivisionError', 'division by zero', line);
    const target = scale ?? Math.max(this.scale, other.scale, 2);
    if (target > MAX_SCALE) {
      throw pedagError('ValueError', `a scale of ${target} is beyond the maximum of ${MAX_SCALE}`, line);
    }
    // Scale the numerator so the integer division lands at `target` digits,
    // with one extra digit kept to decide the rounding.
    const shift = target - this.scale + other.scale + 1;
    const numerator = shift >= 0 ? this.c * pow10(shift) : this.c / pow10(-shift);
    const quotient = numerator / other.c;
    return new Decimal(roundHalfEven(quotient), target);
  }

  rescale(scale, line = null) {
    if (scale === this.scale) return this;
    if (scale > this.scale) return new Decimal(this.c * pow10(scale - this.scale), scale);
    const drop = this.scale - scale;
    const divisor = pow10(drop - 1);
    return new Decimal(roundHalfEven(this.c / divisor), scale);
  }

  negate() { return new Decimal(-this.c, this.scale); }
  abs() { return new Decimal(this.c < 0n ? -this.c : this.c, this.scale); }

  compare(other) {
    const [x, y] = Decimal.align(this, other);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  equals(other) { return this.compare(other) === 0; }
  get isZero() { return this.c === 0n; }
  get sign() { return this.c < 0n ? -1 : this.c > 0n ? 1 : 0; }

  // Only when it is safe. A decimal that cannot be a float exactly says so
  // rather than handing back an approximation.
  toNumber(line = null) {
    const asNumber = Number(this.toString());
    if (!Number.isFinite(asNumber) || Decimal.parse(String(asNumber)).compare(this) !== 0) {
      throw pedagError('ValueError',
        `${this.toString()} cannot become a num without losing precision`, line)
        .help('keep it as a dec, or round it first with .round(n)');
    }
    return asNumber;
  }

  toString() {
    const negative = this.c < 0n;
    let digits = (negative ? -this.c : this.c).toString();
    if (this.scale === 0) return (negative ? '-' : '') + digits;
    if (digits.length <= this.scale) digits = digits.padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const frac = digits.slice(digits.length - this.scale);
    return `${negative ? '-' : ''}${whole}.${frac}`;
  }

  pedagMembers(interp) {
    return {
      scale: this.scale,
      round: nf('round', 1, (a, line) => this.rescale(Math.trunc(interp.asNumber(a[0], 'a scale', line)), line)),
      div: nf('div', 2, (a, line) => this.div(expectDec(a[0], 'a divisor', line),
        Math.trunc(interp.asNumber(a[1], 'a scale', line)), line)),
      abs: nf('abs', 0, () => this.abs()),
      sign: nf('sign', 0, () => this.sign),
      is_zero: nf('is_zero', 0, () => this.isZero),
      to_num: nf('to_num', 0, (_a, line) => this.toNumber(line)),
      text: nf('text', 0, () => this.toString()),
    };
  }
}

// Round the last digit away, half to even. `q` carries one extra digit.
function roundHalfEven(q) {
  const negative = q < 0n;
  const value = negative ? -q : q;
  const quotient = value / 10n;
  const remainder = value % 10n;
  let rounded = quotient;
  if (remainder > 5n) rounded += 1n;
  else if (remainder === 5n && quotient % 2n === 1n) rounded += 1n;
  return negative ? -rounded : rounded;
}

export function expectDec(v, what, line) {
  const u = v && v.value !== undefined && v.labels ? v.value : v;
  if (!(u instanceof Decimal)) {
    throw pedagError('TypeError', `${what} must be a dec`, line)
      .help('`dec("1.50")` builds one from text');
  }
  return u;
}

// Arithmetic between decimals. A float on either side is refused: silent
// promotion is precisely the failure this type prevents.
export function decimalBinary(op, l, r, line) {
  const left = l instanceof Decimal ? l : null;
  const right = r instanceof Decimal ? r : null;
  const other = left ? r : l;

  if (!left || !right) {
    // A whole number is unambiguous, so `price * 3` works. A float is not.
    if (typeof other === 'number' && Number.isInteger(other)) {
      const lifted = Decimal.fromInteger(other, line);
      return decimalBinary(op, left ? l : lifted, left ? lifted : r, line);
    }
    if (typeof other === 'number') {
      throw pedagError('TypeError',
        `cannot mix \`dec\` with the float \`${other}\`; that would put a rounding error into exact arithmetic`, line)
        .help(`write it exactly: \`dec("${other}")\``);
    }
    throw pedagError('TypeError', `\`${op}\` is not defined between \`dec\` and this value`, line);
  }

  switch (op) {
    case '+': return left.add(right);
    case '-': return left.sub(right);
    case '*': return left.mul(right);
    case '/': return left.div(right, undefined, line);
    case '==': return left.equals(right);
    case '!=': return !left.equals(right);
    case '<': return left.compare(right) < 0;
    case '<=': return left.compare(right) <= 0;
    case '>': return left.compare(right) > 0;
    case '>=': return left.compare(right) >= 0;
    default:
      throw pedagError('TypeError', `\`${op}\` is not defined on \`dec\``, line)
        .help('use .div(divisor, scale) when you need to say how to round');
  }
}
