; io.asm — write the string "Hi!" to port 0xFE via OUT.
;
; Try:  npm run cli -- examples/io.asm --port 0xFE

        .org    0x8000

start:
        ld      a, 'H'
        out     (0xFE), a
        ld      a, 'i'
        out     (0xFE), a
        ld      a, '!'
        out     (0xFE), a
        ret
