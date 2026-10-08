Write an interpreter for a small Scheme. `/app/lisp FILE` runs the program in FILE and prints what it displays. Use any language available on this computer and make `/app/lisp` executable.

The language:
- integers of any size, decimals, `#t` and `#f`, strings with the escapes `\n`, `\t`, `\"` and `\\`, symbols, lists, `'x` for `(quote x)`, and `;` comments;
- special forms `define` (also `(define (f a b) ...)` and `(define (f . args) ...)`), `lambda` (also `(lambda args ...)`), `if`, `cond` with `else`, `let`, `let*`, `letrec`, `begin`, `set!`, `and`, `or`, `quote`;
- procedures `+ - * /` (`/` gives an integer when the division is exact, a decimal otherwise), `quotient`, `remainder`, `modulo`, `= < > <= >=` (with any number of arguments), `abs`, `min`, `max`, `not`, `eq?`, `equal?`, `null?`, `pair?`, `list?`, `number?`, `string?`, `symbol?`, `procedure?`, `boolean?`, `cons`, `car`, `cdr`, `list`, `length`, `append`, `reverse`, `map`, `filter`, `apply`, `display`, `newline`, `error`, `string-append`, `string-length`, `number->string`, `symbol->string`;
- `display` writes values as Scheme does: `#t`, `(1 (2 3))`, `(1 . 2)`, `()`, a string without quotes, but strings inside a list with them;
- calls in tail position must not grow the stack: a loop of a million iterations written as a tail-recursive procedure must work, and so must an ordinary (non-tail) recursion 5000 calls deep;
- an error (an undefined variable, calling something that is not a procedure, `car` of an empty list, a division by zero, a call of `error`) stops the program: what it displayed before stays printed on standard output, `error: ` and a message go to standard error, and the exit code is 1. Otherwise the exit code is 0.

It will be checked with programs you have not seen.
