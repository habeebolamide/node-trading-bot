import { Decimal as BaseDecimal } from 'decimal.js';
// NUMERIC(38,18) monetary state needs guard digits during multiplication/division.
// Keep this local: TA/strategy source identity and its analysis arithmetic are unchanged.
export const FinancialDecimal = BaseDecimal.clone({
  precision: 60,
  rounding: BaseDecimal.ROUND_HALF_EVEN,
});
