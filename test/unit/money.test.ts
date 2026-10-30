import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/shared/domain-error";
import { Money } from "../../src/domain/shared/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("serializes with fixed scale 2", () => {
    expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("25.5").amount).toBe("25.50");
    expect(brl("0.01").amount).toBe("0.01");
    expect(Money.zero("BRL").toString()).toBe("0.00 BRL");
  });

  test("arithmetic is exact (no float drift)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
    expect(brl("100.00").subtract(brl("80.00")).amount).toBe("20.00");
    expect(brl("999999999999999999.99").subtract(brl("0.01")).amount).toBe("999999999999999999.98");
    let acc = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) acc = acc.add(brl("0.01"));
    expect(acc.amount).toBe("10.00");
  });

  test("is immutable", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.amount).toBe("10.00");
    expect(b.amount).toBe("15.00");
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("negate / sign predicates", () => {
    const n = brl("10.00").negate();
    expect(n.isNegative()).toBe(true);
    expect(n.amount).toBe("-10.00");
    expect(Money.zero("BRL").negate().amount).toBe("0.00");
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(Money.from({ amount: "-0.00", currency: "BRL" }, { allowNegative: true }).amount).toBe("0.00");
    expect(() => brl("-0.00")).toThrow(InvalidMoneyError);
  });

  test.each([
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["1e3"],
    ["1E3"],
    [""],
    [" 1.00"],
    ["1.00 "],
    ["1.001"],
    ["1."],
    [".5"],
    ["+1.00"],
    ["1,00"],
    ["0x10"],
    ["-1.00"],
    ["1000000000000000000.00"],
  ])("rejects invalid amount %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejects non-string amounts (numbers are never money)", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });

  test("negative only when explicitly allowed (internal values)", () => {
    expect(Money.from({ amount: "-1.50", currency: "BRL" }, { allowNegative: true }).amount).toBe("-1.50");
  });

  test.each([["brl"], ["BR"], ["BRLL"], [""], ["12A"]])("rejects invalid currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("operations across currencies throw", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl("1.00").equals(usd)).toBe(false);
  });
});
