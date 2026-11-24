// SPDX-License-Identifier: GPL-3.0-only
// Generated from client.source.mjs with native PartialArguments.
// Upstream utility license: DSH-VALUES-LICENSE.txt.
window.__ModuleLoader__.load({id:"dsh-dynamic-context",factory(require){
//#region lib/types/partial-json.js
/**
* Lazily scanned view of one JSON object's top-level fields, built from text
* that may still be streaming or from an already parsed object. Nothing is
* scanned until a reader asks; the view remembers every question it answered
* and reports changed answers when the owner refreshes for publication.
* Used for model tool-call arguments: a row reads the fields it
* cares about at whatever granularity it displays, at every stage of the call.
* @module @deepseek-ai/dsh-util-values/src/partial-json
*/
const SIMPLE_ESCAPES = {
	"\"": "\"",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	"
};
const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c) {
	return c === " " || c === "\n" || c === "\r" || c === "	";
}
function isHex(c) {
	return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
}
/**
* The view. A streaming instance grows through {@link PartialArguments.append};
* {@link PartialArguments.fromText} and {@link PartialArguments.fromObject} build
* sealed instances over a finished call. Every reader is total: an absent or
* differently typed field answers `undefined` (or `false`), never throws.
*/
var PartialArguments = class PartialArguments {
	/** The view of a call with no arguments available. */
	static EMPTY = PartialArguments.fromObject({});
	/**
	* View finished argument text without scanning it until a reader asks.
	* @param text - the complete argument JSON text.
	* @returns a sealed view.
	*/
	static fromText(text) {
		const view = new PartialArguments();
		view.append(text);
		view.sealed = true;
		return view;
	}
	/**
	* View an already parsed argument payload, such as a PTC dispatch object.
	* @param value - the parsed argument value.
	* @returns a sealed view; a non-object payload has no fields.
	*/
	static fromObject(value) {
		const view = new PartialArguments();
		view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
		view.sealed = true;
		return view;
	}
	/**
	* The source: text so far or a parsed object, plus whether it can still grow.
	* These are the only enumerable fields, so two views over the same source
	* compare equal structurally however far each has been read.
	*/
	chunks = [];
	object;
	sealed = false;
	#ends = [];
	#size = 0;
	#consumed = 0;
	#mode = "root";
	#escape = false;
	#keyStart = 0;
	#keyEscaped = false;
	#key = "";
	#current = null;
	#nestedEnds = [];
	#nestedInString = false;
	#invalidAt;
	#invalidValue = false;
	#entries = /* @__PURE__ */ new Map();
	#order = [];
	#reads = /* @__PURE__ */ new Map();
	/** Whether this view rejects further appends; does not scan text or register reads. */
	get isSealed() {
		return this.sealed;
	}
	/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
	get invalid() {
		this.scan();
		return this.#mode === "invalid" || this.#invalidValue;
	}
	/**
	* Retain streamed argument text without scanning or comparing observed answers.
	* @param fragment - the text following every fragment appended before.
	*/
	append(fragment) {
		if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
		if (fragment.length === 0) return;
		this.chunks.push(fragment);
		this.#size += fragment.length;
		this.#ends.push(this.#size);
	}
	/**
	* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
	* @param text - the final argument text, which replaces missing or conflicting deltas.
	* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
	*/
	settle(text) {
		if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
		let offset = 0;
		for (const chunk of this.chunks) {
			if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
			offset += chunk.length;
		}
		this.chunks = text.length === 0 ? [] : [text];
		this.#ends = text.length === 0 ? [] : [text.length];
		this.sealed = true;
		return this;
	}
	/**
	* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
	* @returns whether any observed answer changed since its first read or the preceding refresh.
	*/
	refresh() {
		if (this.#reads.size === 0) return false;
		this.scan();
		let changed = false;
		let completions = false;
		for (const read of this.#reads.values()) {
			if (read.completion) {
				completions = true;
				continue;
			}
			changed = this.refreshRead(read) || changed;
		}
		if (completions) {
			for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
		}
		if (this.sealed) this.#reads.clear();
		return changed;
	}
	refreshRead(read) {
		const now = read.answer();
		if (Object.is(now, read.last)) return false;
		read.last = now;
		return true;
	}
	/**
	* Check whether no further fields can arrive.
	* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
	*/
	closed() {
		return this.remember("closed", "", () => this.closedNow());
	}
	/**
	* List discovered fields in first-appearance order.
	* @returns top-level keys seen so far, in first-appearance order.
	*/
	keys() {
		return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
	}
	/**
	* Check whether a top-level field has appeared.
	* @param key - argument name.
	* @returns whether the field has appeared (a string opened or another value began).
	*/
	has(key) {
		return this.remember("has", key, () => this.hasNow(key));
	}
	/**
	* Check whether a field's closing delimiter has arrived, without validating its contents.
	* @param key - argument name.
	* @returns whether its delimiter arrived and no content reader has reported an error for this value.
	*/
	complete(key) {
		return this.remember("complete", key, () => this.completeNow(key));
	}
	/**
	* Read string length without materializing its text.
	* @param key - argument name.
	* @param options - change granularity for a streaming string.
	* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
	*/
	stringLength(key, options) {
		const step = Math.max(1, Math.floor(options?.step ?? 1));
		const offset = options?.offset ?? 0;
		return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
	}
	/**
	* Check a string against a decoded UTF-16 length limit without materializing it.
	* @param key - argument name.
	* @param maxLength - decoded UTF-16 limit, floored to at least zero.
	* @returns whether the string is longer than the limit; false when absent or not a string.
	*/
	stringExceeds(key, maxLength) {
		const limit = Math.max(0, Math.floor(maxLength));
		return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
	}
	/**
	* Read a decoded string, including a streaming prefix.
	* @param key - argument name.
	* @returns the string field's decoded text so far; undefined when absent or not a string.
	*/
	text(key) {
		return this.remember("text", key, () => this.textNow(key));
	}
	/**
	* Read at most the first decoded UTF-16 units of a string.
	* @param key - argument name.
	* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
	* @returns the bounded string prefix; undefined when absent or not a string.
	*/
	textPrefix(key, maxLength) {
		const limit = Math.max(1, Math.floor(maxLength));
		return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
	}
	/**
	* Read a completed non-string argument.
	* @param key - argument name.
	* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
	*/
	value(key) {
		return this.remember("value", key, () => this.valueNow(key));
	}
	/** Answer a question and, on a streaming view, remember it for change detection. */
	remember(kind, key, read, comparison) {
		this.scan();
		const result = read();
		if (!this.sealed) {
			const id = `${kind}/${key}`;
			if (!this.#reads.has(id)) this.#reads.set(id, {
				completion: kind === "complete",
				answer: comparison === void 0 ? read : () => comparison(read()),
				last: comparison === void 0 ? result : comparison(result)
			});
		}
		return result;
	}
	closedNow() {
		return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
	}
	keysNow() {
		return this.object === void 0 ? this.#order : Object.keys(this.object);
	}
	hasNow(key) {
		return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
	}
	completeNow(key) {
		if (this.object !== void 0) return Object.hasOwn(this.object, key);
		const entry = this.#entries.get(key);
		return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
	}
	lengthNow(key, limit = Number.POSITIVE_INFINITY) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.length : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
		const read = entry.length ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, limit, false);
		return read.length;
	}
	textNow(key) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
			let text;
			try {
				text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
			} catch (_error) {}
			if (text !== void 0) entry.text = {
				at: entry.end,
				length: text.length,
				text
			};
		}
		const read = entry.text ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, Number.POSITIVE_INFINITY, true);
		return read.text;
	}
	textPrefixNow(key, maxLength) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.slice(0, maxLength) : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
		let read = prefixes.get(maxLength);
		if (read === void 0) {
			read = {
				at: entry.start,
				length: 0,
				text: ""
			};
			prefixes.set(maxLength, read);
		}
		this.readString(entry, read, maxLength, true);
		return read.text;
	}
	valueNow(key) {
		if (this.object !== void 0) {
			if (!Object.hasOwn(this.object, key)) return void 0;
			const field = this.object[key];
			return typeof field === "string" ? void 0 : field;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
		if (entry.parsed === void 0) try {
			entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
		} catch (_error) {
			entry.invalid = true;
			this.#invalidValue = true;
		}
		return entry.parsed;
	}
	chunkAt(at) {
		let low = 0;
		let high = this.#ends.length;
		while (low < high) {
			const mid = low + high >>> 1;
			if (this.#ends[mid] <= at) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	/** Materialize only a requested range, never the cumulative source. */
	slice(start, end) {
		if (start >= end) return "";
		const first = this.chunkAt(start);
		const last = this.chunkAt(end - 1);
		const base = first === 0 ? 0 : this.#ends[first - 1];
		if (first === last) return this.chunks[first].slice(start - base, end - base);
		const parts = [this.chunks[first].slice(start - base)];
		for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
		parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
		return parts.join("");
	}
	readString(entry, read, limit, materialize) {
		const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
		if (!entry.needsDecoding) {
			const length = Math.min(end - read.at, limit - read.length);
			if (length <= 0) return;
			if (materialize) read.text += this.slice(read.at, read.at + length);
			read.at += length;
			read.length += length;
			return;
		}
		let chunkIndex = this.chunkAt(read.at);
		while (read.at < end && read.length < limit) {
			const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
			const chunk = this.chunks[chunkIndex];
			const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
			const boundary = remaining.search(CONTENT_ESCAPE);
			const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
			if (length > 0) {
				if (materialize) read.text += remaining.slice(0, length);
				read.at += length;
				read.length += length;
				if (read.at === base + chunk.length) chunkIndex++;
				continue;
			}
			const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
			let decoded;
			let width = 2;
			if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
			if (remaining[0] === "\\" && type === "u") {
				const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
				let valid = true;
				for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
				if (valid) {
					if (hex.length < 4 && entry.end < 0) return;
					if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
				}
				width = 6;
			} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
			if (decoded === void 0) {
				entry.invalidAt = read.at;
				this.#invalidValue = true;
				return;
			}
			if (materialize) read.text += decoded;
			read.length++;
			read.at += width;
			while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
		}
	}
	/** Locate new field ranges without decoding or parsing their contents. */
	scan() {
		if (this.object !== void 0 || this.#consumed === this.#size) return;
		for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
			const pending = this.chunks[i];
			const base = i === 0 ? 0 : this.#ends[i - 1];
			for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
				if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
					const end = this.stringBoundary(pending, index);
					this.#consumed += end - index;
					index = end;
					if (index === pending.length) break;
				}
				this.step(pending[index], this.#consumed);
				this.#consumed++;
			}
		}
	}
	/** Only raw quotes and their preceding backslash runs can terminate a string. */
	stringBoundary(fragment, start) {
		let at = start;
		while (true) {
			const quote = fragment.indexOf("\"", at);
			const end = quote < 0 ? fragment.length : quote;
			if (this.#mode === "string") {
				const entry = this.#current;
				if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
			}
			let slashStart = end;
			while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
			const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
			this.#escape = quote < 0 && escaped;
			if (quote < 0 || !escaped) return end;
			at = quote + 1;
		}
	}
	step(c, at) {
		switch (this.#mode) {
			case "root":
				if (isWhitespace(c)) return;
				if (c === "{") {
					this.#mode = "key-or-end";
					return;
				}
				this.fail();
				return;
			case "key-or-end":
				if (isWhitespace(c)) return;
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key-only":
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key":
				this.stepKey(c, at);
				return;
			case "colon":
				if (isWhitespace(c)) return;
				if (c === ":") {
					this.#mode = "value";
					return;
				}
				this.fail();
				return;
			case "value":
				this.beginValue(c, at);
				return;
			case "string": {
				const entry = this.#current;
				entry.end = at;
				this.#current = null;
				this.#mode = "comma-or-end";
				return;
			}
			case "scalar":
				this.stepScalar(c, at);
				return;
			case "nested":
				this.stepNested(c, at);
				return;
			case "comma-or-end":
				if (isWhitespace(c)) return;
				if (c === ",") {
					this.#mode = "key-only";
					return;
				}
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				this.fail();
				return;
			case "closed":
				if (isWhitespace(c)) return;
				this.fail();
				return;
			/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
			case "invalid": return;
			/* v8 ignore next 2 -- Every scanner mode has a handler above. */
			default: assertNever(this.#mode);
		}
	}
	fail() {
		this.#invalidAt = this.#consumed;
		this.#mode = "invalid";
		this.#current = null;
	}
	beginKey(at) {
		this.#mode = "key";
		this.#keyStart = at + 1;
		this.#keyEscaped = false;
		this.#escape = false;
	}
	stepKey(c, at) {
		if (c < " ") {
			this.fail();
			return;
		}
		if (this.#escape) {
			this.#escape = false;
			return;
		}
		if (c === "\\") {
			this.#escape = true;
			this.#keyEscaped = true;
			return;
		}
		if (c !== "\"") return;
		const raw = this.slice(this.#keyStart, at);
		if (this.#keyEscaped) try {
			this.#key = JSON.parse(`"${raw}"`);
		} catch (_error) {
			this.fail();
			return;
		}
		else this.#key = raw;
		this.#mode = "colon";
	}
	open(entry) {
		if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
		this.#entries.set(this.#key, entry);
		this.#current = entry;
	}
	beginValue(c, at) {
		if (isWhitespace(c)) return;
		if (c === "\"") {
			this.open({
				kind: "string",
				start: at + 1,
				end: -1,
				needsDecoding: false,
				invalidAt: void 0,
				length: void 0,
				text: void 0,
				prefixes: void 0
			});
			this.#escape = false;
			this.#mode = "string";
			return;
		}
		if (c === "}" || c === "," || c === ":" || c === "]") {
			this.fail();
			return;
		}
		this.open({
			kind: "value",
			start: at,
			end: -1,
			parsed: void 0,
			invalid: false
		});
		if (c === "{" || c === "[") {
			this.#mode = "nested";
			this.#nestedEnds = [c === "{" ? "}" : "]"];
			this.#nestedInString = false;
			this.#escape = false;
			return;
		}
		this.#mode = "scalar";
	}
	stepScalar(c, at) {
		if (c !== "," && c !== "}" && !isWhitespace(c)) return;
		this.closeValue(at);
		this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
	}
	stepNested(c, at) {
		if (this.#nestedInString) {
			this.#nestedInString = false;
			return;
		}
		if (c === "\"") {
			this.#nestedInString = true;
			return;
		}
		if (c === "{" || c === "[") {
			this.#nestedEnds.push(c === "{" ? "}" : "]");
			return;
		}
		if (c === "}" || c === "]") {
			if (this.#nestedEnds.pop() !== c) {
				this.fail();
				return;
			}
			if (this.#nestedEnds.length === 0) {
				this.closeValue(at + 1);
				this.#mode = "comma-or-end";
			}
		}
	}
	closeValue(end) {
		const entry = this.#current;
		entry.end = end;
		this.#current = null;
	}
};
//#endregion
//#region lib/types/index.js
/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
/** Whether a realm-owned intrinsic prototype has a native constructor matching this engine's representation. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === "Array" ? Array : Object);
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return void 0;
	return keys;
}
/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value, detach) {
	const ancestors = /* @__PURE__ */ new Set();
	let root;
	const assign = (destination, item) => {
		if (destination === void 0) return;
		if (destination.kind === "root") root = item;
		else if (destination.kind === "array") destination.target[destination.index] = item;
		else Object.defineProperty(destination.target, destination.key, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true
		});
	};
	const tasks = [{
		kind: "visit",
		value,
		...detach ? { destination: { kind: "root" } } : {}
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			ancestors.delete(task.source);
			continue;
		}
		if (task.kind === "array-item") {
			if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return void 0;
			tasks.push({
				kind: "visit",
				value: task.source[task.index],
				...task.target === void 0 ? {} : { destination: {
					kind: "array",
					target: task.target,
					index: task.index
				} }
			});
			continue;
		}
		if (task.kind === "object-property") {
			tasks.push({
				kind: "visit",
				value: task.source[task.key],
				...task.target === void 0 ? {} : { destination: {
					kind: "object",
					target: task.target,
					key: task.key
				} }
			});
			continue;
		}
		const current = task.value;
		if (current === null) {
			assign(task.destination, null);
			continue;
		}
		if (typeof current === "boolean" || typeof current === "string") {
			assign(task.destination, current);
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) return void 0;
			assign(task.destination, current);
			continue;
		}
		if (typeof current !== "object") return void 0;
		if (ancestors.has(current)) return void 0;
		if (Array.isArray(current)) {
			if (!hasPlainArrayPrototype(current)) return void 0;
			const length = current.length;
			if (Reflect.ownKeys(current).length !== length + 1) return void 0;
			const target = detach ? [] : void 0;
			if (target !== void 0) assign(task.destination, target);
			ancestors.add(current);
			tasks.push({
				kind: "leave",
				source: current
			});
			for (let index = length - 1; index >= 0; index--) tasks.push({
				kind: "array-item",
				source: current,
				index,
				...target === void 0 ? {} : { target }
			});
			continue;
		}
		if (!hasPlainObjectPrototype(current)) return void 0;
		const keys = enumerableStringKeys(current);
		if (keys === void 0) return void 0;
		const target = detach ? {} : void 0;
		if (target !== void 0) assign(task.destination, target);
		ancestors.add(current);
		tasks.push({
			kind: "leave",
			source: current
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) return void 0;
			tasks.push({
				kind: "object-property",
				source: current,
				key,
				...target === void 0 ? {} : { target }
			});
		}
	}
	return detach ? root : true;
}
/**
* Validate and detach lossless JSON in one read per property.
* @param value - candidate value to validate and detach.
* @returns the detached snapshot, or `undefined` when the value is not losslessly JSON-serializable.
*/
function snapshotJsonValue(value) {
	return walkJsonValue(value, true);
}
/**
* Test the same lossless JSON rules as {@link snapshotJsonValue} without detaching the value.
* @param value - candidate value to test.
* @returns whether the value survives a JSON round trip without loss.
*/
function isJsonValue(value) {
	return walkJsonValue(value, false) === true;
}
/**
* Compare JSON-compatible values structurally.
* @param a - one JSON-compatible value.
* @param b - the other JSON-compatible value.
* @returns whether both values contain the same JSON data.
*/
function deepEqualJson(a, b) {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEqualJson(entry, b[index]));
	}
	const left = a;
	const right = b;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && deepEqualJson(left[key], right[key]));
}
/**
* Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
* @param value - value to freeze.
* @returns the same value after every reachable enumerable child is frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
/**
* Weak-key lookup with a strongly retained iterable set of associated values.
*
* Each value must belong to only one key. The container performs no automatic
* cleanup; owners delete associations or clear the container at lifecycle end.
*/
var WeakMapWithValues = class {
	keys = /* @__PURE__ */ new WeakMap();
	valueSet = /* @__PURE__ */ new Set();
	/** Live strongly retained values in insertion order. */
	values = this.valueSet;
	/**
	* Read the value associated with a key.
	* @param key - weakly held lookup key.
	* @returns the associated value, or absence.
	*/
	get(key) {
		return this.keys.get(key);
	}
	/**
	* Test whether a key has an association.
	* @param key - weakly held lookup key.
	* @returns whether the key is present.
	*/
	has(key) {
		return this.keys.has(key);
	}
	/**
	* Associate one key with one caller-unique value.
	* @param key - weakly held lookup key.
	* @param value - strongly retained value that belongs to no other key.
	* @returns this container.
	*/
	set(key, value) {
		if (this.keys.has(key)) {
			const previous = this.keys.get(key);
			if (previous === value) return this;
			this.valueSet.delete(previous);
		}
		this.keys.set(key, value);
		this.valueSet.add(value);
		return this;
	}
	/**
	* Remove one association and its strongly retained value.
	* @param key - weakly held lookup key.
	* @returns whether an association was removed.
	*/
	delete(key) {
		if (!this.keys.has(key)) return false;
		const value = this.keys.get(key);
		const deleted = this.keys.delete(key);
		this.valueSet.delete(value);
		return deleted;
	}
	/** Remove every association and strongly retained value. */
	clear() {
		this.keys = /* @__PURE__ */ new WeakMap();
		this.valueSet.clear();
	}
};
//#endregion


// SPDX-License-Identifier: GPL-3.0-only
// The native staged form addresses flat field names. Keep nested profile operations
// on their individual paths so a save cannot replace an unrelated sibling.
function configFormScope(scope, fields) {
  const paths = new Map(fields.map(f => [f.key, f.key.split('.')]))
  const project = values => {
    if (values === undefined) return undefined
    const result = {}
    for (const [key, path] of paths) {
      let node = values
      for (const part of path) node = node && typeof node === 'object' && Object.hasOwn(node, part) ? node[part] : undefined
      if (node !== undefined) result[key] = node
    }
    return result
  }
  return {
    subscribe: listener => scope.subscribe(listener),
    getSnapshot() {
      const snapshot = scope.getSnapshot()
      const value = project(snapshot.value), user = project(snapshot.user)
      // Some optional sections normalize an explicit null to a missing effective value.
      for (const [key, entry] of Object.entries(user ?? {}))
        if (value && value[key] === undefined && entry === null) value[key] = null
      return { ...snapshot, value, base: project(snapshot.base), user }
    },
    mutate(ops, revision) {
      // Apply whole-section edits first so an explicitly edited child wins in the same save.
      const changes = ops.map(op => ({ ...op, path: paths.get(op.path[0]) }))
      return scope.mutate(changes.sort((a, b) => a.path.length - b.path.length), revision)
    },
  }
}

function fieldSpec(field) {
  return {
    field: field.key,
    format(value) {
      if (value === undefined) return ''
      return field.type === 'json' ? JSON.stringify(value, null, 2) : String(value)
    },
    parse(text) {
      if (!text.trim()) return { kind: 'clear' }
      let value = text.trim()
      if (field.type === 'json') {
        try { value = JSON.parse(text) } catch { return undefined }
      } else if (field.type === 'boolean') {
        if (!['true', 'false'].includes(value)) return undefined
        value = value === 'true'
      } else if (field.type === 'integer' || field.type === 'number') {
        if (field.nullable && value === 'null') value = null
        else {
          value = Number(value)
          if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value))) return undefined
          if (field.min !== undefined && value < field.min || field.max !== undefined && value > field.max) return undefined
        }
      } else if (field.choices && !field.choices.includes(value)) return undefined
      else if (field.type === 'multiline') value = text
      return { kind: 'set', value }
    },
  }
}

function installConfigCard(ctx, React, primitives, options) {
  const { SettingsForm, SettingsFormModel, Button } = primitives ?? {}
  if (!ctx.inject || !SettingsFormModel) return
  const { id, title, en, description, groups, order } = options
  ctx.inject(['configForms', 'locale'], scoped => {
    const h = React.createElement, locale = 'settings.' + id
    scoped.effect(() => scoped.locale.register(locale, { zh: { title }, en: { title: en } }))
    const fields = groups.flatMap(group => group.fields)
    const form = new SettingsFormModel(configFormScope(scoped.configForms.get(id), fields), fields.map(fieldSpec))
    const store = form.bind(() => ({ ...form.shell(), fields: Object.fromEntries(fields.map(f => [f.key, form.field(f.key)])) }))
    scoped.effect(() => () => form.dispose())
    function Card(props) {
      const state = props.usePluginConfig(snapshot => snapshot)
      if (props.view === 'summary') return description
      function control(field) {
        const { text, invalid, overridden } = state.fields[field.key]
        const inputId = id + '-' + field.key
        const common = { id: inputId, value: text, disabled: !state.writable, 'aria-invalid': invalid,
          onChange: event => props.edit(field.key, event.target.value),
          style: { width: '100%', boxSizing: 'border-box', color: 'inherit', background: 'var(--dsw-alias-bg-base, transparent)',
            border: '1px solid var(--dsw-alias-border-primary, #8888)', borderRadius: 6, padding: 8 } }
        const choices = field.choices ?? (field.type === 'boolean' ? ['true', 'false'] : null)
        const input = choices ? h('select', common,
          h('option', { value: '' }, '沿用默认'),
          ...choices.map((value, i) => h('option', { key: value, value }, field.labels?.[i] ?? ({ true: '开启', false: '关闭' }[value] ?? value))))
          : ['json', 'multiline'].includes(field.type) ? h('textarea', { ...common, rows: 4, spellCheck: false })
          : h('input', { ...common, type: 'text', inputMode: field.type === 'integer' && !field.nullable ? 'numeric' : undefined })
        return h('div', { key: field.key, style: { margin: '12px 0' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('label', { htmlFor: inputId }, field.label),
            h('small', { style: { opacity: 0.7, overflowWrap: 'anywhere' } }, field.key),
            overridden && h(Button, { size: 'small', variant: 'ghost', disabled: !state.writable, onClick: () => props.resetField(field.key) }, '恢复默认')),
          input, field.hint && h('small', null, field.hint), invalid && h('p', { role: 'alert' }, '请检查输入格式。'))
      }
      return h(SettingsForm, { state, onSave: props.save, onDiscard: props.discard,
        labels: { unavailable: '插件尚未加载。', readOnly: '当前部署只读。', saveFailed: '保存失败，请检查配置组合或重新加载最新设置。',
          save: '保存', saving: '保存中…' } }, h('p', null, description), ...groups.map((group, i) =>
          h('details', { key: group.title, open: i === 0 ? true : undefined, style: { margin: '12px 0' } },
            h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, group.title), ...group.fields.map(control))))
    }
    scoped.effect(() => scoped.configForms.whileServed([id], () => scoped.slots.inject('plugins.item', () => scoped.slots.register({
      name: 'plugins.item', id, order, label: () => scoped.locale.bind(locale)('title'), locale,
      inject: () => ({ hooks: { pluginConfig: store }, ...form.actions() }),
    }, Card))))
  })
}

function configField(key, label, type = 'text', options = {}) {
  return { key, label, type, ...options }
}
const unitLimitFields = [
  configField('workflowLimits.maxUnits', '全图单元总数（含根）', 'integer', { min: 1 }),
  configField('workflowLimits.maxDepth', '递归深度', 'integer', { min: 0 }),
  configField('workflowLimits.preloadBytes', '预装上下文合计字节数', 'integer', { min: 0 }),
  configField('workflowLimits.dynamicMaterialBytes', '动态材料转摘要的字节数', 'integer', { min: 0 }),
]

// SPDX-License-Identifier: GPL-3.0-only
const PERFORMANCE_EVENT = 'plugin:dsh-dynamic-context/performance-v1'
const PERFORMANCE_KEY = 'dynamicContextPerformance'
const zeroUsage = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const zeroStats = () => ({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 })
const nonnegative = value => Number.isFinite(value) && value >= 0
function normalizeUsage(value, native = false) {
  if (!value) return null
  const input = native ? value.inputTokens : value.prompt_tokens, output = native ? value.outputTokens : value.completion_tokens
  const read = native ? value.cacheReadTokens ?? 0 : value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0
  const write = native ? value.cacheWriteTokens ?? 0 : value.prompt_tokens_details?.cache_write_tokens ?? 0
  const uncached = native ? input : input - read - write
  if (![uncached, output, read, write].every(nonnegative)) return null
  return { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write }
}
function performanceView(samples) {
  const usage = zeroUsage(), stats = zeroStats(), groups = new Set()
  let latest, missingUsage = 0, requests = 0, running = 0
  for (const sample of Object.values(samples)) {
    if (sample.kind === 'tool') { stats.toolMs += sample.toolMs ?? 0; continue }
    if (sample.kind === 'aggregate') {
      for (const key of Object.keys(usage)) usage[key] += sample.usage?.[key] ?? 0
      for (const key of Object.keys(stats)) stats[key] += sample.stats?.[key] ?? 0
      requests += sample.requests ?? 0; missingUsage += sample.missingUsage ?? 0
      continue
    }
    if (!latest || sample.startedAt > latest.startedAt || sample.startedAt === latest.startedAt && sample.order > latest.order) latest = sample
    if (sample.kind === 'native-anchor') continue
    requests++; if (sample.state === 'running') running++
    if (sample.usage) for (const key of Object.keys(usage)) usage[key] += sample.usage[key]
    else if (sample.state !== 'running') missingUsage++
    if (sample.state === 'running') continue
    stats.steps++; if (sample.countsTurn !== false) groups.add(sample.group)
    if (nonnegative(sample.endedAt) && nonnegative(sample.startedAt)) {
      stats.llmMs += Math.max(0, sample.endedAt - sample.startedAt)
      if (nonnegative(sample.firstTokenAt) && sample.firstTokenAt >= sample.startedAt) {
        stats.ttftMs += sample.firstTokenAt - sample.startedAt; stats.ttftSteps++
        if (sample.usage && sample.endedAt > sample.firstTokenAt) {
          stats.decodeMs += sample.endedAt - sample.firstTokenAt; stats.decodeTokens += sample.usage.outputTokens
        }
      }
    }
  }
  stats.turns += groups.size
  const input = latest?.usage ? latest.usage.uncachedInputTokens + latest.usage.cacheReadTokens + latest.usage.cacheWriteTokens : latest?.inputTokens
  return { usage, stats, requests, running, missingUsage, current: latest ? {
    native: latest.kind === 'native-anchor', source: latest.source, startedAt: latest.startedAt,
    pressure: { ...(nonnegative(input) ? { pressureTokens: input, projectedTokens: input } : {}),
      ...(latest.contextWindow > 0 ? { contextWindow: latest.contextWindow } : {}) },
    ...(latest.breakdown ? { breakdown: latest.breakdown } : {}),
  } : null }
}
function performanceProjection(key, native, extra) {
  if (!extra) return native
  if (key === 'sessionStats' || key === 'tokenUsage') {
    const added = key === 'sessionStats' ? extra.stats : extra.usage
    return Object.fromEntries(Object.entries(added).map(([field, value]) => [field, (native?.[field] ?? 0) + value]))
  }
  if (extra.current && !extra.current.native) {
    if (key === 'contextPressure') return extra.current.pressure
    if (key === 'contextBreakdown') return extra.current.breakdown
  }
  return native
}

// SPDX-License-Identifier: GPL-3.0-only

function structuredLabel(text) {
  const raw = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1').trim()
  let value
  try { value = JSON.parse(raw) } catch {
    return /^(?:\{\s*"|\[\s*(?:\{|\[|"|\d|true|false|null))/.test(raw) ? 'JSON 数据（生成中或格式待修正）' : null
  }
  if (!value || typeof value !== 'object') return null
  if (value.action === 'COMPLETE' && value.children) return '组级终审报告 · JSON'
  if (value.modifications && value.action === 'REVISE') return '分层蓝图修改报告 · JSON'
  if (value.title && value.achievements && value.verification) return '任务总结报告 · JSON'
  if (value.action === 'PAUSE') return '中断申请报告 · JSON'
  if (value.action === 'REWORK') return '返工申请报告 · JSON'
  if (value.executionReport || value.workHistory && value.results) return '执行报告 · JSON'
  if (value.taskGraph && value.contextGraph || value.proposal?.taskGraph) return '任务图与上下文图 · JSON'
  if (value.taskGraph || value.plan?.nodes) return '任务图 · JSON'
  if (value.contextGraph) return '上下文图 · JSON'
  if (value.changeReport || value.changes) return '图修改报告 · JSON'
  if (value.verdict) return '验收或复查结果 · JSON'
  if (value.outcome) return '执行处置报告 · JSON'
  if (value.edits) return '局部修改请求 · JSON'
  return '结构化数据 · JSON'
}
function structuredParts(text) {
  const full = structuredLabel(text)
  if (full) return [{ text, label: full }]
  const result = [], pattern = /```json\s*\n[\s\S]*?\n```/gi
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) result.push({ text: text.slice(offset, match.index) })
    result.push({ text: match[0], label: structuredLabel(match[0]) ?? 'JSON 数据（格式待修正）' })
    offset = match.index + match[0].length
  }
  if (offset < text.length) result.push({ text: text.slice(offset) })
  return result
}
function installNativePresentation(ctx, React, primitives) {
  const { createElement: h, useMemo } = React
  function withStatistics(Base) {
    return function StatisticsSource(props) {
      const nativeProjection = props.useProjection
      const useProjection = useMemo(() => (key, selector = value => value) => {
        const native = nativeProjection(key)
        const extra = nativeProjection(PERFORMANCE_KEY)
        const value = useMemo(() => performanceProjection(key, native, extra), [key, native, extra])
        return selector(value)
      }, [nativeProjection])
      return h(Base, { ...props, useProjection })
    }
  }
  function StructuredContent({ Base, props, block, label }) {
    const { expanded, toggle } = props.useDisclosure()
    const raw = block.text.trim()
    const fence = '`'.repeat(Math.max(3, ...[...raw.matchAll(/`+/g)].map(match => match[0].length + 1)))
    const text = /^```(?:json)?\s*\n/.test(raw) ? raw : fence + 'json\n' + block.text + '\n' + fence
    return h('div', { 'data-structured-content': label }, h(primitives.DisclosureRow, {
      title: label, open: expanded, expandable: true, expandOnRowClick: true, onToggle: toggle,
      children: expanded ? h(Base, { ...props, node: { ...props.node, data: { ...props.node.data, blocks: [{ ...block, text }] } } }) : undefined,
    }))
  }
  function CompactionContent({ Base, props, title }) {
    // Native disclosure state starts closed and retains the user's choice while
    // streaming. The native assistant still owns Markdown, copy and timestamps.
    const { expanded, toggle } = props.useDisclosure()
    return h('div', { 'data-context-compaction': 'result' }, h(primitives.DisclosureRow, {
      title, open: expanded, expandable: true, expandOnRowClick: true, onToggle: toggle,
      children: expanded ? h(Base, props) : undefined,
    }))
  }
  function withStructuredContent(Base) {
    return function StructuredAssistant(props) {
      const output = props.node.data.dynamicContextOutput
      if (output?.kind === 'compaction' && props.groupPart !== 'reasoning')
        return h(CompactionContent, { Base, props, title: output.title })
      const parts = props.node.data.blocks.flatMap(block => block.kind === 'text'
        ? structuredParts(block.text).map(part => ({ block: { ...block, text: part.text }, label: part.label })) : [{ block }])
      if (!parts.some(part => part.label) || props.groupPart === 'reasoning') return h(Base, props)
      return h(React.Fragment, null, ...parts.map((part, index) => part.label
        ? h(StructuredContent, { key: index, Base, props, ...part })
        : h(Base, { ...props, key: index, node: { ...props.node, data: { ...props.node.data, blocks: [part.block] } } })))
    }
  }
  const wrapped = new WeakMap()
  ctx.provide('dynamicContextPresentation', {
    component(slotKey, entry) {
      const statistics = slotKey === 'conversation.composer.bar' || slotKey === 'conversation.composer.dock' && ['activity', 'usage'].includes(entry.options.id)
      const structured = slotKey === 'conversation.chat.node' && entry.options.key === 'assistant-step'
      const flow = slotKey === 'conversation.chat.flow'
      if (!statistics && !structured && !flow) return entry.component
      if (!wrapped.has(entry)) wrapped.set(entry, flow ? completedLeafFlow(ctx, React, primitives, entry.component) : statistics ? withStatistics(entry.component) : withStructuredContent(entry.component))
      return wrapped.get(entry)
    },
  })
}

// Completed-leaf and role-step display folding; never edits persisted events.
const foldStages = {
  PREPLANNING: '预规划', EXECUTING: '执行', result_check: '结果验收',
  result_repair: '报告补正', result_work: '成果返工', plan_check: '计划复查',
  updater: '图更新', reviewer: '修改审计', compaction: '上下文压缩',
  blockage: '阻塞处理', blockage_audit: '中断审核', group_audit: '组级终审',
  unit_planner: '单元规划', unit_rebaseline: '单元重基线', unit_plan_audit: '规划审计', unit_audit: '单元终审', scope_plan: '本层计划复查', scope_update: '本层蓝图更新', scope_audit: '修改审计',
  scope_blockage: '分层阻塞处理', scope_pause: '中断审核', task_reporter: '任务报告',
  unit_router: '单元路由', baseline_audit: '基线审计', guidance_intake: '用户引导识别', guidance_router: '用户引导分派',
  progress_reporter: '阶段执行报告',
}
const leafStages = new Set(['EXECUTING', 'result_check', 'result_repair', 'result_work', 'compaction'])
function foldMetadata(workflowId, row) {
  return { workflowId, taskId: row.taskId, taskLabel: row.taskLabel,
    sessionId: row.sessionId, step: row.step, stage: row.stage, kind: row.kind, state: row.state }
}
function completedIndex(value, sessionId, previous) {
  const workflowId = value?.execution?.workflowId, graph = value?.graph
  if (value?.sessionId !== sessionId || value.status !== 'ready' || typeof workflowId !== 'string'
    || !Array.isArray(graph?.nodes) || !Number.isSafeInteger(graph.revision)
    || previous?.workflowId === workflowId && graph.revision < previous.revision) return null
  const leaves = new Map(graph.nodes.filter(n => n.kind === 'leaf' && n.status === 'COMPLETE'
    && !n.blocked && n.id !== graph.active?.nodeId).map(n => [n.id, n.label]))
  const signature = JSON.stringify([workflowId, graph.revision, [...leaves]])
  return previous?.signature === signature ? previous : { sessionId, workflowId, revision: graph.revision, leaves, signature }
}
const runKey = m => JSON.stringify([m.workflowId, m.taskId ?? null, m.stage, m.sessionId ?? null])
const stepKey = m => runKey(m) + ':' + m.step
const metaOf = (entry, nodes) => entry.kind === 'node' ? nodes.get(entry.key)?.data?.dynamicContextFold : null
const known = m => m && typeof m.workflowId === 'string' && foldStages[m.stage] && Number.isSafeInteger(m.step)
function count(entries, nodes) {
  const steps = new Set(), rows = new Set(); let errors = 0
  for (const e of entries) { const m = metaOf(e, nodes); rows.add(e.key); if (known(m)) steps.add(stepKey(m)); if (m?.state === 'error' || m?.state === 'interrupted') errors++ }
  return { steps: steps.size, rows: rows.size, errors }
}
// Preserve contiguous order. User messages, native groups and unrelated roles
// are hard boundaries; they can never be swallowed by a neighbouring leaf.
function foldPlan(entries, nodes, completed, { steps = true } = {}) {
  const latest = new Map()
  for (const e of entries) { const m = metaOf(e, nodes); if (known(m)) latest.set(runKey(m), m.step) }
  function phasePlan(list) {
    const parts = []
    for (const e of list) {
      const m = metaOf(e, nodes)
      const key = steps && known(m) && m.state === 'complete' && m.step !== latest.get(runKey(m)) ? runKey(m) : null
      const last = parts.at(-1)
      if (key && last?.type === 'steps' && last.run === key) last.entries.push(e)
      else if (key) parts.push({ type: 'steps', key: 'steps:' + e.key, run: key, title: foldStages[m.stage], taskLabel: m.taskLabel, entries: [e] })
      else if (last?.type === 'native') last.entries.push(e)
      else parts.push({ type: 'native', key: 'native:' + e.key, entries: [e] })
    }
    for (const p of parts) if (p.type === 'steps') Object.assign(p, count(p.entries, nodes))
    return parts
  }
  const outer = []
  for (const e of entries) {
    const m = metaOf(e, nodes)
    const key = known(m) && m.state !== 'running' && leafStages.has(m.stage)
      && m.workflowId === completed?.workflowId && completed.leaves.has(m.taskId) ? m.taskId : null
    const last = outer.at(-1)
    if (key && last?.type === 'leaf' && last.taskId === key) last.entries.push(e)
    else if (key) outer.push({ type: 'leaf', key: 'leaf:' + e.key, taskId: key,
      title: completed.leaves.get(key) || m.taskLabel || key, entries: [e] })
    else if (last?.type === 'unfolded') last.entries.push(e)
    else outer.push({ type: 'unfolded', entries: [e] })
  }
  return outer.flatMap(p => p.type === 'leaf'
    ? [{ ...p, ...count(p.entries, nodes), children: phasePlan(p.entries) }]
    : phasePlan(p.entries))
}
function foldStats(parts) {
  return parts.reduce((s, p) => {
    s.rawEntries += p.entries.length
    s.defaultEntries += p.type === 'native' ? p.entries.length : 1
    if (p.type !== 'native') { s.headers++; s.hiddenEntries += p.entries.length }
    if (p.type === 'leaf') s.leafSections++
    if (p.type === 'steps') s.stepSections++
    return s
  }, { rawEntries: 0, defaultEntries: 0, hiddenEntries: 0, headers: 0, leafSections: 0, stepSections: 0 })
}

function completedLeafFlow(ctx, React, primitives, Base) {
  const { createElement: h, useEffect, useMemo, useRef, useState } = React
  const empty = []
  // Keep the original ChatFlow for every native row, Markdown block and tool.
  // Only the final segment owns pending-input placement and the running footer.
  function Section({ part, props, quiet }) {
    const [open, setOpen] = useState(false)
    const title = part.type === 'leaf' ? `已完成叶任务 · ${part.title}`
      : `${part.title}${part.taskLabel ? ' · ' + part.taskLabel : ''} · 已结束的内部步骤`
    const detail = `${part.steps} 步 · ${part.rows} 条${part.errors ? ` · 含 ${part.errors} 条异常记录` : ''}`
    return h('section', { 'data-completed-fold': part.type, 'data-fold-key': part.key,
      'data-fold-open': String(open), 'data-fold-count': part.entries.length,
      style: { margin: '8px 0', border: '1px solid var(--border-color, #ffffff20)', borderRadius: 8, padding: '6px 10px' } },
      h(primitives.DisclosureRow, { title: title + ' · ' + detail, open, expandable: true,
        expandOnRowClick: true, onToggle: () => setOpen(v => !v),
        children: open ? h('div', { style: { padding: '4px 0' } },
          part.type === 'leaf' ? renderParts(part.children, props, quiet, false)
            : h(Base, { ...props, ...quiet, entries: part.entries })) : undefined }))
  }
  function renderParts(parts, props, quiet, owner) {
    const children = parts.map((p, i) => p.type === 'native'
      ? h(Base, { ...props, ...(!owner || i !== parts.length - 1 ? quiet : {}), key: p.key, entries: p.entries })
      : h(Section, { key: p.key, part: p, props, quiet }))
    if (owner && parts.at(-1)?.type !== 'native') children.push(h(Base, { ...props, key: 'flow-tail', entries: empty }))
    return children
  }
  return function CompletedLeafFlow(props) {
    const sessionId = props.sessionId
    const nodes = props.useChat(s => s.nodes)
    const [status, setStatus] = useState(null)
    const previous = useRef(null)
    const hasRecordedRows = useMemo(() => props.entries.some(e => known(metaOf(e, nodes))), [props.entries, nodes])
    useEffect(() => {
      previous.current = null
      if (!hasRecordedRows || !sessionId) return
      let cancelled = false, timer; const controller = new AbortController()
      async function refresh() {
        let index = null
        try {
          const api = ctx.get('remote.transactionGraphView')
          const result = await api?.status({ sessionId }, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
          if (cancelled) return
          index = result?.ok ? completedIndex(result.value, sessionId, previous.current) : null
        } catch { if (cancelled) return }
        if (index) previous.current = index
        setStatus(s => s?.sessionId === sessionId && s.index === index ? s : { sessionId, index })
        if (!cancelled) timer = setTimeout(refresh, 2500)
      }
      void refresh()
      return () => { cancelled = true; controller.abort(); clearTimeout(timer) }
    }, [sessionId, hasRecordedRows])
    const quiet = useMemo(() => ({ pendingInputs: empty,
      useSession: selector => props.useSession(s => selector({ ...s, running: false })) }), [props.useSession])
    const index = status?.sessionId === sessionId ? status.index : null
    const parts = useMemo(() => foldPlan(props.entries, nodes, index), [props.entries, nodes, index])
    if (hasRecordedRows && sessionId && status?.sessionId !== sessionId)
      return h('p', { role: 'status' }, '正在整理已完成任务的显示…')
    return h(React.Fragment, null, ...renderParts(parts, props, quiet, true))
  }
}

// SPDX-License-Identifier: GPL-3.0-only
const preferenceFields = [
  { key: 'permissionMode', label: '执行权限', hint: '继承主会话；选定的上限不会扩大主会话授权。', choices: [['configured', '按配置'], ['auto', '继承'], ['read-only', '只读'], ['workspace-write', '工作区'], ['danger-full-access', '完整访问']] },
  { key: 'approvalPolicy', label: '工具批准', hint: '主会话的批准策略始终生效。', choices: [['configured', '按配置'], ['auto', '继承'], ['ask', '可询问'], ['never', '不询问']] },
  { key: 'reasoningEffort', label: '推理强度', hint: '自动继承主会话；明确强度仅适用于 DeepSeek 接口。', choices: [['configured', '按配置'], ['auto', '继承'], ['off', '关闭'], ['low', '低'], ['high', '高'], ['max', '最高']] },
  { key: 'contextWindow', label: '上下文窗口（token）', hint: '0 沿用配置文件；131072–1048576。同步原生压缩阈值，不改变模型实际容量。', min: 131072, max: 1048576, zero: true },
  { key: 'maxRequestsPerTask', label: '每角色额外请求次数上限', min: 1, max: 256, limit: true },
  { key: 'timeoutMs', label: '每角色额外超时（毫秒）', min: 10, max: 1800000, limit: true },
]
const configGroups = [
  { title: '安装与工作模式', fields: [
    configField('enabled', '启用动态上下文', 'boolean'),
    configField('interaction.commandMode', '/task-graph 的默认模式', 'choice', { choices: ['full', 'ask', 'task-graph', 'native'], labels: ['完整单元工作流', '每次询问新会话', '独立任务图', '原生对话'] }),
    configField('interaction.mode', '运行入口', 'choice', { choices: ['interactive', 'host'] }),
    configField('interaction.orchestration', '程序编排', 'boolean'),
    configField('supervision', '监督执行', 'boolean'), configField('supervisionContext', '监督输入', 'choice', { choices: ['reports','legacy'] }),
    configField('preplanningAcceptance', '预规划验收', 'boolean'), configField('unitFinalReport', '单元最终报告', 'boolean'),
    configField('exposeControlTools', '开放控制工具', 'boolean'), configField('interop.enabled', '任务图联动', 'boolean', { choices: ['true'], labels: ['必需'] }),
    configField('interop.workflowId', '宿主工作流 ID', 'text', { hint: '交互模式为各个会话生成独立 ID。' }),
  ] },
  { title: '单元与材料限制', fields: unitLimitFields },
  { title: '工作目录与存储', fields: [
    configField('projectRoot', '项目根目录'), configField('storageRoot', '私有存储根目录'), configField('directory', '工作流数据目录'),
    configField('storageFormat', '新实例存储格式', 'choice', { choices: ['auto', 'sqlite', 'files'] }),
  ] },
  { title: '模型与 API 连接', fields: [
    configField('provider', '模型提供方'), configField('model', '模型 ID'),
    configField('transport', '请求通道', 'choice', { choices: ['direct', 'native-guarded'] }),
    configField('direct.endpoint', 'API 地址'), configField('direct.api', 'API 类型', 'choice', { choices: ['deepseek', 'openai-compatible'] }),
    configField('direct.protocol', '请求协议', 'choice', { choices: ['auto', 'messages', 'chat-completions'] }),
    configField('direct.auth', '认证方式', 'choice', { choices: ['deepseek-account', 'api-key'] }),
    configField('direct.apiKeyEnv', '凭据名称', 'text', {hint:'填写 DSH 凭据引用或环境变量名。密钥在 DSH 凭据设置中管理。'}),
    configField('direct.thinking', '模型思考设置', 'json', { hint: '{"type":"enabled"} 或 {"type":"disabled"}。' }),
    configField('direct.reasoningEffort', '模型推理强度', 'choice', { choices: ['auto','off','low','high','max'] }),
    configField('direct.responseModelAliases', '响应模型别名列表', 'json'),
    ...Object.entries({ temperature: '温度', top_p: '累积概率', top_k: '候选数', min_p: '最小概率', repeat_penalty: '重复惩罚',
      repeat_last_n: '重复检测长度', presence_penalty: '出现惩罚', frequency_penalty: '频率惩罚', seed: '随机种子' })
      .map(([key, label]) => configField('direct.generation.' + key, label, ['seed','top_k','repeat_last_n'].includes(key) ? 'integer' : 'number')),
  ] },
  { title: '执行、压缩与恢复', fields: [
    configField('systemPrompt', '固定系统提示', 'multiline'), configField('allowedTools', '允许的工具 ID 列表', 'json'),
    configField('maxInputTokens', '输入 token 预算', 'integer'), configField('maxOutputTokens', '输出 token 预算', 'integer'),
    ...[['maxRequestsPerTask','每角色请求次数'], ['timeoutMs','每角色超时（毫秒）'], ['direct.maxRequestBytes','请求字节限制'],
      ['direct.maxResponseBytes','响应字节限制']].map(([key, label]) => configField(key, label, 'integer', { nullable: true, hint: 'null 表示不额外限制。' })),
    configField('direct.streamIdleTimeoutMs', '流式响应空闲超时（毫秒）', 'integer'),
    configField('direct.durable', '持久化检查点', 'boolean'), configField('direct.tracePayloads', '请求记录方式', 'choice', { choices: ['references','inline'] }),
    configField('direct.reserveFinalReport','预留最终报告请求','boolean'), configField('direct.contextWindow','上下文窗口（token）','integer'),
    configField('direct.compaction','压缩策略与参数','json', {hint:'原生策略使用 strategy、contextWindow。字符策略使用 triggerCharacters、retainRecentExchanges、maxCompactions、maxCheckpointCharacters。null 关闭。'}),
    configField('direct.agentlessTools','无执行身份时允许的工具 ID','json'),
    configField('revision.maxOutputTokens','蓝图修订输出 token 数','integer'), configField('revision.policy.objective','蓝图修订目标','multiline'),
    configField('revision.policy.requirements','蓝图修订要求','json',{hint:'每条要求填写 id 和 text。交互工作流会采用用户任务的验收要求。'}),
  ] },
  { title: '执行环境与工具', fields: [
    ...[['modules','原生模块'], ['registeredTools','额外注册的工具 ID'], ['planReadTools','Plan 中允许读取的额外工具'],
      ['skills','允许的 Skill'], ['requiredSkills','必需的 Skill'], ['privateReadRoots','私有只读根目录'], ['toolContextSources','工具上下文来源']]
      .map(([key,label]) => configField('direct.runtime.' + key, label, 'json')),
    ...[['instructions','装载工作区指令'], ['plan','Plan 只读模式'], ['protectPrivatePaths','保护私有路径'], ['nativeRequestControls','原生请求控制']]
      .map(([key,label]) => configField('direct.runtime.' + key, label, 'boolean')),
    configField('direct.runtime.cwd','执行工作目录'), configField('direct.runtime.timeZone','时区'),
    configField('direct.runtime.instructionHomes','指令目录','json',{hint:'包含绝对路径 dshHome 与 agentsHome。'}),
    configField('direct.runtime.sandboxMode','执行权限上限','choice',{choices:['auto','read-only','workspace-write','danger-full-access']}),
    configField('direct.runtime.approvalPolicy','批准策略','choice',{choices:['auto','never','ask']}),
  ] },
  { title: '角色、Skill、工具与报错策略', fields: [
    configField('rolePolicyFile','角色策略文件路径'), configField('rolePolicy.version','角色策略格式版本','integer',{min:1,max:1}),
    ...[['modelBackends','命名模型及 API 后端'],['roleModels','各角色的模型后端'],['roleStrategies','各角色的工具白／黑名单策略'],
      ['skills','角色预装 Skill 登记'],['roleTools','按 DSH 工具 ID、操作和优先级登记']]
      .map(([key,label]) => configField('rolePolicy.' + key,label,'json')),
    configField('rolePolicy.toolErrors.mode','工具报错转交策略','choice',{choices:['blacklist','whitelist']}),
    configField('rolePolicy.toolErrors.includeDefaults','包含内置错误规则','boolean'), configField('rolePolicy.toolErrors.rules','错误类型、工具与转交规则','json'),
  ] },
  { title: '可选配置段', fields: [
    configField('direct.runtime', '完整执行环境配置', 'json', {hint:'可整段设置，null 关闭原生执行身份。'}),
    configField('revision', '完整蓝图修订配置', 'json', {hint:'可整段设置，null 清除修订配置；已启用监督时需要修订策略。'}),
    configField('direct', '完整 Direct 配置', 'json', {hint:'用于切换通道或整段替换；宿主对完整配置做一致性校验。'}),
  ] },
  { title: '新工作流偏好覆盖', fields: preferenceFields.map(f => configField('preferences.' + f.key, f.label, f.choices ? 'choice' : 'integer', {
    hint: f.hint, ...(f.choices ? { choices: f.choices.map(o => o[0]), labels: f.choices.map(o => o[1]) } : {}),
  })) },
]

function installPreferenceSettings(ctx, React, primitives) {
  installConfigCard(ctx, React, primitives, { id: 'dsh-dynamic-context', title:'动态上下文', en:'Dynamic context', order:55, groups:configGroups,
    description:'新会话使用 /task-graph 进入完整单元流程。单元总数和新任务偏好可以即时保存。修改后端、策略或存储等部署项时，DSH 会重新装载插件。' })
}

// SPDX-License-Identifier: GPL-3.0-only
// Keys are the original wire IDs, including historical tools shown in replay.
const dynamicToolNames = {
  dynamic_context_route_task: ['路由任务请求', 'Route task request'],
  dynamic_context_select_mode: ['选择任务图模式', 'Select task graph mode'],
  dynamic_context_graph_status: ['检查任务图与上下文图', 'Check task and context graphs'],
  dynamic_context_status: ['查看工作流状态', 'Read workflow status'],
  dynamic_context_recover_graphs: ['恢复任务图与上下文图', 'Recover task and context graphs'],
  dynamic_context_revise: ['修订任务图与上下文图', 'Revise task and context graphs'],
  dynamic_context_continue_supervision: ['继续监督流程', 'Continue workflow supervision'],
  dynamic_context_run_next: ['执行下一单元', 'Run next unit'],
  dynamic_context_pause: ['暂停执行', 'Pause execution'],
  dynamic_context_resume: ['恢复执行', 'Resume execution'],
  dynamic_context_reconcile: ['核对中断的执行尝试', 'Reconcile interrupted attempt'],
  dynamic_context_maintenance: ['维护工作流存储', 'Maintain workflow storage'],
  dynamic_context_workflow: ['管理任务图工作流', 'Manage task graph workflow'],
  dynamic_context_set_rule_tree: ['设置前序规则树', 'Set prerequisite rule tree'],
  dynamic_context_set_rule: ['编辑单条前序规则', 'Edit a prerequisite rule'],
  dynamic_context_set_named_rule: ['编写含命名片段的前序规则', 'Define a prerequisite rule with named parts'],
  dynamic_context_edit_rule_part: ['编辑前序规则片段', 'Edit prerequisite rule fragment'],
  dynamic_context_read_rules: ['读取前序规则', 'Read prerequisite rules'],
  dynamic_context_manage_rules: ['管理前序规则草稿', 'Manage prerequisite rule drafts'],
  dynamic_context_submit: ['提交任务图与上下文图', 'Submit task and context graphs'],
  dynamic_context_planning_history: ['查阅规划历史', 'Read planning history'],
  dynamic_task_status: ['查看当前任务状态', 'Read current task status'],
  dynamic_context_source_read: ['读取已绑定的原始证据', 'Read bound source evidence'],
  dynamic_context_source_search: ['检索已绑定的原始证据', 'Search bound source evidence'],
  dynamic_context_shared_read: ['读取共享事实', 'Read shared facts'],
  dynamic_context_shared_update: ['更新共享事实', 'Update shared facts'],
  dynamic_context_directory_snapshot: ['获取目录快照', 'Capture directory snapshot'],
  dynamic_context_generate_report: ['生成报告草稿', 'Generate report draft'],
  dynamic_context_read_report: ['读取报告草稿', 'Read report draft'],
  dynamic_context_rewrite_report: ['修订报告草稿', 'Revise report draft'],
  dynamic_context_submit_report: ['提交报告', 'Submit report'],
  dynamic_context_read_evidence: ['读取角色证据', 'Read role evidence'],
  dynamic_context_search_evidence: ['检索角色证据', 'Search role evidence'],
  dynamic_context_select_receipt: ['选择执行回执', 'Select execution receipt'],
  dynamic_context_blockage_reports: ['列出工作流报告', 'List workflow reports'],
  dynamic_context_blockage_shared: ['查阅共享事实及历史', 'Inspect shared facts and history'],
  dynamic_context_blockage_topology: ['查看任务图拓扑', 'Inspect task graph topology'],
  dynamic_context_blockage_history: ['查阅工作流决策历史', 'Read workflow decision history'],
  dynamic_context_blockage_report: ['读取工作流报告原文', 'Read original workflow report'],
  dynamic_context_blockage_trace: ['查阅单元执行轨迹', 'Inspect unit execution trace'],
  dynamic_context_workspace_list: ['列出工作区目录内容', 'List workspace directory contents'],
  dynamic_context_workspace_read: ['核验并读取工作区文件', 'Verify and read workspace file'],
  dynamic_context_workspace_zip: ['检查工作区 ZIP 归档', 'Inspect workspace ZIP archive'],
}

// SPDX-License-Identifier: GPL-3.0-only
// Project log-only observations into existing DSH Chat node kinds. Native Chat
// owns Markdown, reasoning disclosures, tool cards, terminal output and settings.
const DISPLAY_EVENT = 'plugin:dsh-dynamic-context/execution-display-v1'
const stages = { PREPLANNING: '预规划', EXECUTING: '叶执行', result_check: '结果验收', result_repair: '报告补正', result_work: '成果返工',
  plan_check: '计划复查', updater: '图更新', reviewer: '修改审计', compaction: '上下文压缩',
  blockage: '阻塞处理', blockage_audit: '中断审核', group_audit: '组级终审', unit_planner: '单元规划', unit_rebaseline: '单元重基线', unit_plan_audit: '规划审计', unit_audit: '单元终审', scope_plan: '本层计划复查', scope_update: '本层蓝图更新',
  scope_audit: '修改审计', scope_blockage: '分层阻塞处理', scope_pause: '中断审核', task_reporter: '任务报告', progress_reporter: '阶段执行报告', unit_router: '单元路由', baseline_audit: '基线审计', guidance_intake: '用户引导识别', guidance_router: '用户引导分派' }
const escapeMarkdown = text => String(text).replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&')
function executionChatDefinition(PartialArguments) {
  const start = match => ({ row: match.event.data.row, text: match.event.data.text,
    workflowId: match.event.data.workflowId, native: match.event.data.native, missingPrefix: match.event.data.offset > 0, seq: match.event.seq })
  return {
    kind: 'dynamic-context-execution', target: 'chat',
    match: event => event.type === DISPLAY_EVENT && event.data?.version === 1 && typeof event.data.row?.id === 'string'
      ? { id: event.data.workflowId + ':' + event.data.row.id, role: 'start' } : null,
    start: (_context, match) => start(match),
    update: (context, match) => {
      const data = match.event.data, previous = context.state
      if (data.row.revision <= previous.row.revision) return previous
      if (data.reset) return { ...start(match), seq: previous.seq }
      return { ...previous, row: data.row, native: data.native ?? previous.native,
        missingPrefix: previous.missingPrefix || data.offset !== previous.row.bytes,
        text: previous.text + data.text }
    },
    buildViewNode: context => {
      const { row, text, native, missingPrefix, seq } = context.state
      if (row.kind === 'tool_input') return null
      const dynamicContextFold = foldMetadata(context.state.workflowId, row)
      const location = context.start?.location ?? { kind: 'session' }, turn = location.turn?.turn ?? 0
      const base = { key: context.key, id: context.id, target: 'chat', anchorSeq: seq,
        location, visibility: 'visible', groupTree: 'turn' }
      if (row.kind === 'tool' && native) {
        const head = { callId: native.callId ?? row.id, name: native.name ?? row.title, turn, step: row.step,
          time: Date.parse(row.at), subCalls: [], args: PartialArguments.fromText(native.argsRaw ?? '{}') }
        const root = row.state === 'running' ? { ...head, phase: 'start', argsRaw: native.argsRaw ?? '{}' }
          : { ...head, kind: 'tool-result', seq, call: { name: head.name, argsRaw: native.argsRaw ?? '{}' },
            callTime: Date.parse(row.at), content: native.content ?? [{ type: 'text', text: '执行中断；没有最终工具回执，不能视为成功。' }],
            ...(native.meta === undefined ? {} : { meta: native.meta }),
            isError: native.isError || row.state === 'error' || row.state === 'interrupted', ...(native.error ? { error: native.error } : {}) }
        return { ...base, kind: 'tool-call', data: { root, dynamicContextFold } }
      }
      const label = `后台执行 · ${stages[row.stage] ?? row.stage}${row.taskLabel ? ' · ' + row.taskLabel : ''} · 第 ${row.step} 步`
      const body = row.kind === 'model' ? `_${escapeMarkdown(label)}_`
        : (missingPrefix ? '〔当前历史窗口中的输出片段〕\n' : '') + text
      return { ...base, kind: 'assistant-step', data: { dynamicContextFold, turn, step: row.step, time: Date.parse(row.at),
        status: row.state === 'running' ? 'running' : row.state === 'interrupted' ? 'interrupted' : 'settled',
        // Presentation metadata only: keep the summary's original Markdown and
        // classify from the recorded request purpose, never from generated prose.
        ...(row.stage === 'compaction' && row.kind === 'message' ? { dynamicContextOutput: {
          kind: 'compaction', title: '上下文压缩结果' + ({ running: '（生成中）', interrupted: '（已中断）', error: '（失败）' }[row.state] ?? '')
            + ` · 第 ${row.step} 步`,
        } } : {}),
        blocks: [{ kind: row.kind === 'reasoning' ? 'reasoning' : 'text', text: body }] } }
    },
  }
}
function createExecutionClient(PartialArguments, React, primitives) {
  const chat = executionChatDefinition(PartialArguments)
  // The native tool card's Inspect action navigates to its Trajectory entry.
  // Supply that same observed result to the native view, without a second UI.
  const trajectory = { ...chat, kind: 'dynamic-context-execution-tool', target: 'trajectory',
    match: event => event.data?.row?.kind === 'tool' ? chat.match(event) : null,
    buildViewNode: context => {
      const node = chat.buildViewNode(context)
      return node?.kind === 'tool-call' ? { ...node, target: 'trajectory', kind: context.kind,
        data: { kind: 'tool', root: node.data.root } } : null
    } }
  return { inject: ['uiConversation', 'slots'], apply(ctx) {
    ctx.uiConversation.events.register(chat); ctx.uiConversation.events.register(trajectory)
    ctx.inject(['transactionGraphToolDisplay', 'locale'], scoped => {
      scoped.transactionGraphToolDisplay.register(scoped, 'dynamicContext.tools', dynamicToolNames)
    })
    if (React && primitives) installNativePresentation(ctx, React, primitives)
    if (React && primitives) installPreferenceSettings(ctx, React, primitives)
  } }
}

return createExecutionClient(PartialArguments, require("react"), require("@deepseek-ai/dsh-client-ui-primitives"));
}});
