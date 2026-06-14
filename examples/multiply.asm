; multiply.asm — 8-bit unsigned multiply.
;
; Input:  B = multiplicand, C = multiplier
; Output: HL = B * C, and the low byte is stored at RESULT (0x9000)
;
; Try:  npm run cli -- examples/multiply.asm --reg b=6 --reg c=7 --dump 0x9000:2

        .org    0x8000

start:
        ld      hl, 0           ; running product
        ld      a, c            ; loop counter = multiplier
        or      a               ; counter == 0?
        jr      z, done

        ld      d, 0
        ld      e, b            ; DE = multiplicand (16-bit)

loop:
        add     hl, de          ; product += multiplicand
        dec     a
        jr      nz, loop

done:
        ld      a, l            ; store low byte of result
        ld      (RESULT), a
        ret                     ; return to caller (sentinel)

RESULT  =       0x9000
