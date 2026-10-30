import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error";

export interface MoneyProps {
  amount: string; // decimal string with exactly 2 decimal places, e.g. "25.00"
  currency: string; // ISO-4217
}

const SCALE = 2;
// Plain decimal: optional sign, digits, optional fraction of 1..2 digits. No exponent, no spaces.
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// numeric(20,2) in the database: 18 integer digits.
const MAX_ABS = new Decimal("999999999999999999.99");

// Isolated Decimal constructor so global config changes elsewhere cannot affect money math.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * Immutable monetary value. Internally an arbitrary-precision decimal fixed at scale 2;
 * never a JS `number`. Every operation returns a new instance.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Parses a contract value. Accepts negatives only when `allowNegative` is set
   * (used for internal values such as differences); input contracts reject them.
   */
  static from(props: MoneyProps, opts: { allowNegative?: boolean } = {}): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("Money must be an object { amount, currency }");
    }
    const { amount, currency } = props;
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string");
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid amount "${amount}": expected a plain decimal with at most ${SCALE} places`);
    }
    if (amount.startsWith("-") && !opts.allowNegative) {
      throw new InvalidMoneyError("amount must not be negative");
    }
    const value = new D(amount);
    if (value.abs().greaterThan(MAX_ABS)) {
      throw new InvalidMoneyError("amount out of range");
    }
    return new Money(value.isZero() ? new D(0) : value, Money.parseCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new D(0), Money.parseCurrency(currency));
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected ISO-4217 code`);
    }
    return currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.isZero() ? this.value : this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Exact fixed-scale string, e.g. "25.00". */
  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
