import { smarshError } from './errors.js';

const shapeErr = (msg, line) => smarshError('ShapeError', msg, line);

function stridesOf(shape) {
  const s = new Array(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    s[i] = acc;
    acc *= shape[i];
  }
  return s;
}

const sizeOf = (shape) => shape.reduce((a, b) => a * b, 1);

// A dense n-dimensional array of f64. This is a first-class value in Smarsh, not
// a library object: `+ - * / @` on the operator level dispatch to it, and shape
// mismatches are a language-level error with a line number, not a stack trace
// from inside a numeric package.
export class Tensor {
  constructor(data, shape) {
    this.data = data instanceof Float64Array ? data : Float64Array.from(data);
    this.shape = shape.slice();
  }

  static scalar(n) { return new Tensor([n], []); }

  static filled(shape, value) {
    const d = new Float64Array(sizeOf(shape));
    d.fill(value);
    return new Tensor(d, shape);
  }

  static fromNested(nested, line = null) {
    const shape = [];
    let cur = nested;
    while (Array.isArray(cur)) {
      shape.push(cur.length);
      if (cur.length === 0) break;
      cur = cur[0];
    }
    const out = [];
    const walk = (node, depth) => {
      if (depth === shape.length) {
        if (typeof node !== 'number') {
          throw shapeErr(`tensor elements must be numbers, found ${node === null ? 'nil' : typeof node}`, line);
        }
        out.push(node);
        return;
      }
      if (!Array.isArray(node)) throw shapeErr('ragged tensor: nesting depth is not uniform', line);
      if (node.length !== shape[depth]) {
        throw shapeErr(
          `ragged tensor: axis ${depth} has length ${shape[depth]} elsewhere but ${node.length} here`, line);
      }
      for (const child of node) walk(child, depth + 1);
    };
    walk(nested, 0);
    return new Tensor(out, shape);
  }

  get size() { return this.data.length; }
  get rank() { return this.shape.length; }

  toNested() {
    const build = (depth, offset, strides) => {
      if (depth === this.shape.length) return this.data[offset];
      const out = [];
      for (let i = 0; i < this.shape[depth]; i++) {
        out.push(build(depth + 1, offset + i * strides[depth], strides));
      }
      return out;
    };
    return build(0, 0, stridesOf(this.shape));
  }

  at(indices, line = null) {
    if (indices.length !== this.rank) {
      throw shapeErr(`tensor of rank ${this.rank} indexed with ${indices.length} ${indices.length === 1 ? 'index' : 'indices'}`, line);
    }
    const st = stridesOf(this.shape);
    let off = 0;
    for (let i = 0; i < indices.length; i++) {
      let k = Math.trunc(indices[i]);
      if (k < 0) k += this.shape[i];
      if (k < 0 || k >= this.shape[i]) {
        throw shapeErr(`index ${indices[i]} out of bounds on axis ${i} of size ${this.shape[i]}`, line);
      }
      off += k * st[i];
    }
    return this.data[off];
  }

  reshape(shape, line = null) {
    if (sizeOf(shape) !== this.size) {
      throw shapeErr(`cannot reshape ${this.size} elements into [${shape.join(', ')}]`, line);
    }
    return new Tensor(this.data, shape);
  }

  static broadcastShape(a, b, line = null) {
    const n = Math.max(a.length, b.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const da = a[a.length - n + i] ?? 1;
      const db = b[b.length - n + i] ?? 1;
      if (da !== db && da !== 1 && db !== 1) {
        throw shapeErr(`cannot broadcast [${a.join(', ')}] against [${b.join(', ')}]`, line);
      }
      out[i] = Math.max(da, db);
    }
    return out;
  }

  // Read this tensor at an index expressed in a (possibly larger) broadcast
  // shape: leading axes are ignored, size-1 axes are held at 0.
  pick(idx) {
    const st = stridesOf(this.shape);
    const lead = idx.length - this.shape.length;
    let off = 0;
    for (let i = 0; i < this.shape.length; i++) {
      const k = this.shape[i] === 1 ? 0 : idx[lead + i];
      off += k * st[i];
    }
    return this.data[off];
  }

  zip(other, fn, line = null) {
    const shape = Tensor.broadcastShape(this.shape, other.shape, line);
    const n = sizeOf(shape);
    const st = stridesOf(shape);
    const out = new Float64Array(n);
    const idx = new Array(shape.length).fill(0);
    for (let flat = 0; flat < n; flat++) {
      let rem = flat;
      for (let d = 0; d < shape.length; d++) {
        idx[d] = Math.floor(rem / st[d]);
        rem %= st[d];
      }
      out[flat] = fn(this.pick(idx), other.pick(idx));
    }
    return new Tensor(out, shape);
  }

  map(fn) {
    const out = new Float64Array(this.size);
    for (let i = 0; i < this.size; i++) out[i] = fn(this.data[i]);
    return new Tensor(out, this.shape);
  }

  matmul(other, line = null) {
    let a = this;
    let b = other;
    const squeezeA = a.rank === 1;
    const squeezeB = b.rank === 1;
    if (squeezeA) a = a.reshape([1, a.shape[0]]);
    if (squeezeB) b = b.reshape([b.shape[0], 1]);
    if (a.rank !== 2 || b.rank !== 2) {
      throw shapeErr('@ needs rank-1 or rank-2 tensors on both sides', line);
    }
    const [m, k] = a.shape;
    const [k2, n] = b.shape;
    if (k !== k2) {
      throw shapeErr(
        `cannot multiply [${this.shape.join(', ')}] @ [${other.shape.join(', ')}]: inner sizes ${k} and ${k2} differ`, line);
    }
    const out = new Float64Array(m * n);
    for (let i = 0; i < m; i++) {
      for (let p = 0; p < k; p++) {
        const av = a.data[i * k + p];
        if (av === 0) continue;
        for (let j = 0; j < n; j++) out[i * n + j] += av * b.data[p * n + j];
      }
    }
    let shape = [m, n];
    if (squeezeA && squeezeB) shape = [];
    else if (squeezeA) shape = [n];
    else if (squeezeB) shape = [m];
    return new Tensor(out, shape);
  }

  transpose(line = null) {
    if (this.rank <= 1) return this;
    if (this.rank !== 2) throw shapeErr(`.T is defined for rank-2 tensors, got rank ${this.rank}`, line);
    const [r, c] = this.shape;
    const out = new Float64Array(this.size);
    for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) out[j * r + i] = this.data[i * c + j];
    return new Tensor(out, [c, r]);
  }

  sum() { let s = 0; for (const v of this.data) s += v; return s; }
  mean() { return this.size === 0 ? 0 : this.sum() / this.size; }
  max() { let m = -Infinity; for (const v of this.data) if (v > m) m = v; return m; }
  min() { let m = Infinity; for (const v of this.data) if (v < m) m = v; return m; }
  norm() { let s = 0; for (const v of this.data) s += v * v; return Math.sqrt(s); }

  equals(other) {
    if (this.rank !== other.rank) return false;
    for (let i = 0; i < this.rank; i++) if (this.shape[i] !== other.shape[i]) return false;
    for (let i = 0; i < this.size; i++) if (this.data[i] !== other.data[i]) return false;
    return true;
  }

  toString() {
    const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6))));
    if (this.rank === 0) return `tensor(${fmt(this.data[0])})`;
    const render = (depth, offset, strides) => {
      if (depth === this.shape.length - 1) {
        const row = [];
        for (let i = 0; i < this.shape[depth]; i++) row.push(fmt(this.data[offset + i * strides[depth]]));
        return `[${row.join(', ')}]`;
      }
      const parts = [];
      for (let i = 0; i < this.shape[depth]; i++) {
        parts.push(render(depth + 1, offset + i * strides[depth], strides));
      }
      return `[${parts.join(', ')}]`;
    };
    return `tensor${render(0, 0, stridesOf(this.shape))}`;
  }
}

export { stridesOf, sizeOf };
