Write a chess move generator. `/app/perft "<FEN>" <depth>` must print only the number of legal move sequences of `<depth>` plies from the position given in Forsyth-Edwards Notation (the "perft" count): every rule counts, including castling (not out of, through or into check), en passant, promotion to each of the four pieces, and the 50-move and repetition rules do not.

Use any language available on this computer (you may install Ubuntu packages with `sudo dot-install`); make `/app/perft` executable.

It will be checked on positions you have not seen, at depths up to 5, and each count must take less than 15 minutes on this computer. Do not hard-code results.
