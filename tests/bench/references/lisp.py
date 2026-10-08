#!/usr/bin/env python3
"""lisp FILE: runs a program of the Scheme subset of the task."""
import sys


class Symbol(str):
    pass


class Nil:
    def __repr__(self):
        return "()"


NIL = Nil()


class Pair:
    __slots__ = ("car", "cdr")

    def __init__(self, car, cdr):
        self.car, self.cdr = car, cdr


class LispError(Exception):
    pass


def tokenize(text):
    out, i = [], 0
    while i < len(text):
        c = text[i]
        if c in " \t\r\n":
            i += 1
        elif c == ";":
            while i < len(text) and text[i] != "\n":
                i += 1
        elif c in "()'":
            out.append(c)
            i += 1
        elif c == '"':
            j, s = i + 1, []
            while text[j] != '"':
                if text[j] == "\\":
                    j += 1
                    s.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}[text[j]])
                else:
                    s.append(text[j])
                j += 1
            out.append(("str", "".join(s)))
            i = j + 1
        else:
            j = i
            while j < len(text) and text[j] not in " \t\r\n()';\"":
                j += 1
            out.append(text[i:j])
            i = j
    return out


def atom(tok):
    if isinstance(tok, tuple):
        return tok[1]
    if tok == "#t":
        return True
    if tok == "#f":
        return False
    try:
        return int(tok)
    except ValueError:
        try:
            return float(tok)
        except ValueError:
            return Symbol(tok)


def to_list(items, tail=NIL):
    for x in reversed(items):
        tail = Pair(x, tail)
    return tail


def read(tokens, pos):
    tok = tokens[pos]
    if tok == "(":
        items, pos = [], pos + 1
        while tokens[pos] != ")":
            if tokens[pos] == ".":
                tail, pos = read(tokens, pos + 1)
                return to_list(items, tail), pos + 1
            x, pos = read(tokens, pos)
            items.append(x)
        return to_list(items), pos + 1
    if tok == ")":
        raise LispError("unexpected )")
    if tok == "'":
        x, pos = read(tokens, pos + 1)
        return to_list([Symbol("quote"), x]), pos
    return atom(tok), pos + 1


def py_list(x):
    out = []
    while isinstance(x, Pair):
        out.append(x.car)
        x = x.cdr
    return out


class Env(dict):
    def __init__(self, names=(), values=(), outer=None):
        super().__init__()
        self.outer = outer
        if isinstance(names, Symbol):
            self[names] = to_list(list(values))
        else:
            names = list(names)
            if len(names) != len(values):
                raise LispError(f"expected {len(names)} arguments, got {len(values)}")
            self.update(zip(names, values))

    def find(self, name):
        env = self
        while env is not None:
            if name in env:
                return env
            env = env.outer
        raise LispError(f"undefined variable: {name}")


class Procedure:
    def __init__(self, params, body, env):
        self.params, self.body, self.env = params, body, env


def show(x, write=False):
    if x is True:
        return "#t"
    if x is False:
        return "#f"
    if isinstance(x, Symbol):
        return str(x)
    if isinstance(x, str):
        return '"' + x.replace("\\", "\\\\").replace('"', '\\"') + '"' if write else x
    if x is NIL:
        return "()"
    if isinstance(x, Pair):
        parts = []
        while isinstance(x, Pair):
            parts.append(show(x.car, True))
            x = x.cdr
        return "(" + " ".join(parts) + ("" if x is NIL else " . " + show(x, True)) + ")"
    if isinstance(x, (Procedure,)) or callable(x):
        return "#<procedure>"
    if isinstance(x, float) and x == int(x):
        return f"{x:.1f}"
    return str(x)


out = []


def number(*xs):
    for x in xs:
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            raise LispError(f"not a number: {show(x, True)}")


def arith(op):
    def f(*xs):
        number(*xs)
        return op(*xs)
    return f


def div(a, *bs):
    number(a, *bs)
    if not bs:
        bs, a = (a,), 1
    for b in bs:
        if b == 0:
            raise LispError("division by zero")
        a = a // b if isinstance(a, int) and isinstance(b, int) and a % b == 0 else a / b
    return a


def compare(op):
    def f(*xs):
        number(*xs)
        return all(op(a, b) for a, b in zip(xs, xs[1:]))
    return f


def car(x):
    if not isinstance(x, Pair):
        raise LispError(f"car of a non-pair: {show(x, True)}")
    return x.car


def cdr(x):
    if not isinstance(x, Pair):
        raise LispError(f"cdr of a non-pair: {show(x, True)}")
    return x.cdr


def eq(a, b):
    if a is NIL or b is NIL:
        return a is b
    if isinstance(a, Pair) or (isinstance(a, str) and not isinstance(a, Symbol)):
        return a is b
    return type(a) is type(b) and a == b


def equal(a, b):
    if isinstance(a, Pair) and isinstance(b, Pair):
        return equal(a.car, b.car) and equal(a.cdr, b.cdr)
    if a is NIL or b is NIL:
        return a is b
    return type(a) is type(b) and a == b


def apply_proc(f, args):
    if isinstance(f, Procedure):
        return evaluate(f.body, Env(f.params, args, f.env), tail=False)
    if callable(f):
        return f(*args)
    raise LispError(f"not a procedure: {show(f, True)}")


def display(x):
    out.append(show(x))
    return NIL


def newline():
    out.append("\n")
    return NIL


def error(*xs):
    raise LispError(" ".join(show(x) for x in xs))


GLOBAL = Env()
GLOBAL.update({
    "+": arith(lambda *x: sum(x)), "-": arith(lambda a, *b: a - sum(b) if b else -a),
    "*": arith(lambda *x: __import__("math").prod(x)), "/": div,
    "quotient": arith(lambda a, b: int(a / b) if b else error("division by zero")),
    "remainder": arith(lambda a, b: a - b * int(a / b) if b else error("division by zero")),
    "modulo": arith(lambda a, b: a % b if b else error("division by zero")),
    "=": compare(lambda a, b: a == b), "<": compare(lambda a, b: a < b), ">": compare(lambda a, b: a > b),
    "<=": compare(lambda a, b: a <= b), ">=": compare(lambda a, b: a >= b),
    "abs": arith(abs), "min": arith(min), "max": arith(max),
    "not": lambda x: x is False, "eq?": eq,
    "equal?": equal, "null?": lambda x: x is NIL, "pair?": lambda x: isinstance(x, Pair),
    "list?": lambda x: x is NIL or (isinstance(x, Pair) and (lambda y: (y is NIL))(to_tail(x))),
    "number?": lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
    "string?": lambda x: isinstance(x, str) and not isinstance(x, Symbol), "symbol?": lambda x: isinstance(x, Symbol),
    "procedure?": lambda x: isinstance(x, Procedure) or callable(x), "boolean?": lambda x: isinstance(x, bool),
    "cons": Pair, "car": car, "cdr": cdr, "list": lambda *x: to_list(list(x)),
    "length": lambda x: len(py_list(x)), "append": lambda *ls: to_list(sum((py_list(part) for part in ls[:-1]), []), ls[-1]) if ls else NIL,
    "reverse": lambda x: to_list(py_list(x)[::-1]),
    "map": lambda f, *ls: to_list([apply_proc(f, list(args)) for args in zip(*map(py_list, ls))]),
    "filter": lambda f, items: to_list([x for x in py_list(items) if apply_proc(f, [x]) is not False]),
    "apply": lambda f, *args: apply_proc(f, list(args[:-1]) + py_list(args[-1])),
    "display": display, "newline": newline, "error": error,
    "string-append": lambda *s: "".join(s), "number->string": lambda n: show(n), "string-length": len,
    "symbol->string": lambda s: str(s),
})


def to_tail(x):
    while isinstance(x, Pair):
        x = x.cdr
    return x


def evaluate(x, env, tail=False):
    while True:
        if isinstance(x, Symbol):
            return env.find(x)[x]
        if not isinstance(x, Pair):
            return x
        op, args = x.car, x.cdr
        if op == "quote":
            return args.car
        if op == "if":
            items = py_list(args)
            test = evaluate(items[0], env)
            if test is not False:
                x = items[1]
            elif len(items) > 2:
                x = items[2]
            else:
                return NIL
            continue
        if op == "define":
            target = args.car
            if isinstance(target, Pair):
                env[target.car] = Procedure(params_of(target.cdr), begin(args.cdr), env)
                return NIL
            env[target] = evaluate(args.cdr.car, env)
            return NIL
        if op == "set!":
            env.find(args.car)[args.car] = evaluate(args.cdr.car, env)
            return NIL
        if op == "lambda":
            return Procedure(params_of(args.car), begin(args.cdr), env)
        if op == "begin":
            items = py_list(args)
            if not items:
                return NIL
            for item in items[:-1]:
                evaluate(item, env)
            x = items[-1]
            continue
        if op in ("let", "let*", "letrec"):
            bindings = [py_list(b) for b in py_list(args.car)]
            if op == "let":
                env = Env([b[0] for b in bindings], [evaluate(b[1], env) for b in bindings], env)
            else:
                inner = Env(outer=env)
                for name, value in bindings:
                    inner[name] = evaluate(value, inner)
                env = inner
            x = begin(args.cdr)
            continue
        if op == "cond":
            for clause in py_list(args):
                test = clause.car
                if test == "else" or evaluate(test, env) is not False:
                    x = begin(clause.cdr)
                    break
            else:
                return NIL
            continue
        if op == "and":
            items = py_list(args)
            if not items:
                return True
            for item in items[:-1]:
                if evaluate(item, env) is False:
                    return False
            x = items[-1]
            continue
        if op == "or":
            items = py_list(args)
            for item in items[:-1]:
                v = evaluate(item, env)
                if v is not False:
                    return v
            if not items:
                return False
            x = items[-1]
            continue
        f = evaluate(op, env)
        values = [evaluate(a, env) for a in py_list(args)]
        if isinstance(f, Procedure):
            env = Env(f.params, values, f.env)
            x = f.body
            continue
        if callable(f):
            return f(*values)
        raise LispError(f"not a procedure: {show(f, True)}")


def params_of(p):
    if isinstance(p, Symbol):
        return p
    return [Symbol(s) for s in py_list(p)]


def begin(body):
    return Pair(Symbol("begin"), body)


result = [0]


def main():
    sys.setrecursionlimit(200000)
    tokens = tokenize(open(sys.argv[1], encoding="utf-8").read())
    pos = 0
    try:
        while pos < len(tokens):
            expr, pos = read(tokens, pos)
            evaluate(expr, GLOBAL)
    except (LispError, RecursionError) as e:
        message = str(e) if isinstance(e, LispError) else "recursion too deep"
        sys.stderr.write(f"error: {message}\n")
        result[0] = 1
    sys.stdout.write("".join(out))


if __name__ == "__main__":
    import threading
    threading.stack_size(512 * 1024 * 1024)
    t = threading.Thread(target=main)
    t.start()
    t.join()
    sys.stdout.flush()
    sys.exit(result[0])
