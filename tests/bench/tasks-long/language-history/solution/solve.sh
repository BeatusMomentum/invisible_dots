#!/bin/bash
set -euo pipefail
cd /app
cat > languages.csv <<'REFERENCE_EOF'
language,year,creators
C,1972,"Dennis Ritchie"
C++,1985,"Bjarne Stroustrup"
Erlang,1986,"Joe Armstrong; Robert Virding; Mike Williams"
Perl,1987,"Larry Wall"
Python,1991,"Guido van Rossum"
Lua,1993,"Roberto Ierusalimschy; Waldemar Celes; Luiz Henrique de Figueiredo"
Java,1995,"James Gosling"
JavaScript,1995,"Brendan Eich"
PHP,1995,"Rasmus Lerdorf"
Ruby,1995,"Yukihiro Matsumoto"
Scala,2004,"Martin Odersky"
Go,2009,"Robert Griesemer; Rob Pike; Ken Thompson"
Dart,2011,"Lars Bak; Kasper Lund"
Kotlin,2011,"JetBrains (Andrey Breslav)"
Elixir,2012,"José Valim"
Julia,2012,"Jeff Bezanson; Stefan Karpinski; Viral B. Shah; Alan Edelman"
TypeScript,2012,"Anders Hejlsberg (Microsoft)"
Swift,2014,"Chris Lattner (Apple)"
REFERENCE_EOF
cat > influences.dot <<'REFERENCE_EOF'
digraph influences {
  "C" -> "C++";
  "C++" -> "Java";
  "Java" -> "JavaScript";
  "Erlang" -> "Elixir";
  "Ruby" -> "Elixir";
  "JavaScript" -> "TypeScript";
  "Java" -> "Scala";
  "C" -> "Go";
  "Perl" -> "Ruby";
  "Java" -> "Kotlin";
  "Python" -> "Julia";
  "Perl" -> "PHP";
  "C" -> "Python";
  "C++" -> "Python";
  "Perl" -> "Python";
  "Java" -> "Python";
  "C++" -> "Ruby";
  "Lua" -> "Ruby";
  "Python" -> "Ruby";
  "C" -> "PHP";
}
REFERENCE_EOF
cat > report.md <<'REFERENCE_EOF'
# Eighteen programming languages and how they influenced each other

## C

C first appeared in 1972. It was created by Dennis Ritchie. Its design drew on languages outside this list, and in turn it shaped C++, Go, Python. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/C_(programming_language)).

## C++

C++ first appeared in 1985. It was created by Bjarne Stroustrup. Its design drew on C, Java, and in turn it shaped Java, Python, Ruby. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/C%2B%2B_(programming_language)).

## Erlang

Erlang first appeared in 1986. It was created by Joe Armstrong; Robert Virding; Mike Williams. Its design drew on languages outside this list, and in turn it shaped Elixir, Scala, Dart. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/Erlang_(programming_language)).

## Perl

Perl first appeared in 1987. It was created by Larry Wall. Its design drew on C, C++, Python, and in turn it shaped Ruby, PHP, Python. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/Perl_(programming_language)).

## Python

Python first appeared in 1991. It was created by Guido van Rossum. Its design drew on C, C++, Perl, and in turn it shaped Julia, Ruby, Perl. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://www.python.org/doc/essays/foreword/).

## Lua

Lua first appeared in 1993. It was created by Roberto Ierusalimschy; Waldemar Celes; Luiz Henrique de Figueiredo. Its design drew on C++, C, and in turn it shaped Ruby, Julia. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://www.lua.org/history.html).

## Java

Java first appeared in 1995. It was created by James Gosling. Its design drew on C++, C, C++, and in turn it shaped JavaScript, Scala, Kotlin. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://www.oracle.com/java/moved-by-java/timeline/).

## JavaScript

JavaScript first appeared in 1995. It was created by Brendan Eich. Its design drew on Java, C, Python, and in turn it shaped TypeScript, PHP, Kotlin. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/JavaScript_(programming_language)).

## PHP

PHP first appeared in 1995. It was created by Rasmus Lerdorf. Its design drew on Perl, C, C++, and in turn it shaped languages outside this list. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/PHP_(programming_language)).

## Ruby

Ruby first appeared in 1995. It was created by Yukihiro Matsumoto. Its design drew on Perl, C++, Lua, and in turn it shaped Elixir, Dart, Julia. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://www.ruby-lang.org/en/about/).

## Scala

Scala first appeared in 2004. It was created by Martin Odersky. Its design drew on Java, Erlang, C++, and in turn it shaped Kotlin, Swift, Elixir. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://www.scala-lang.org/).

## Go

Go first appeared in 2009. It was created by Robert Griesemer; Rob Pike; Ken Thompson. Its design drew on C, Python, C++, and in turn it shaped Swift, Dart. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://go.dev/doc/faq).

## Dart

Dart first appeared in 2011. It was created by Lars Bak; Kasper Lund. Its design drew on Erlang, JavaScript, Python, and in turn it shaped languages outside this list. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/Dart_(programming_language)).

## Kotlin

Kotlin first appeared in 2011. It was created by JetBrains (Andrey Breslav). Its design drew on Java, Python, Scala, and in turn it shaped Swift. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/Kotlin_(programming_language)).

## Elixir

Elixir first appeared in 2012. It was created by José Valim. Its design drew on Erlang, Ruby, Scala, and in turn it shaped languages outside this list. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://elixir-lang.org/).

## Julia

Julia first appeared in 2012. It was created by Jeff Bezanson; Stefan Karpinski; Viral B. Shah; Alan Edelman. Its design drew on Python, C, Lua, and in turn it shaped languages outside this list. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://julialang.org/blog/2012/02/why-we-created-julia/).

## TypeScript

TypeScript first appeared in 2012. It was created by Anders Hejlsberg (Microsoft). Its design drew on JavaScript, Java, and in turn it shaped Dart. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/TypeScript_(programming_language)).

## Swift

Swift first appeared in 2014. It was created by Chris Lattner (Apple). Its design drew on Kotlin, Python, Ruby, and in turn it shaped Kotlin. Over the years the language grew a community, a standard library and tooling that made it practical for the work it is known for, and its history shows how ideas about syntax, types, memory and concurrency travel from one language to the next. The account here follows the language's own documentation and its encyclopedia entry (https://en.wikipedia.org/wiki/Swift_(programming_language)).
REFERENCE_EOF
