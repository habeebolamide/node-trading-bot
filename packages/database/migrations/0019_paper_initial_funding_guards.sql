CREATE OR REPLACE FUNCTION initialize_paper_capital() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_mode='PAPER' AND NEW.allocation_target_percent>0 THEN
  INSERT INTO paper_capital_ledger(account_id,bot_id,source,kind,amount,event_time)
  SELECT NEW.exchange_account_id,NEW.id,'initial-funding:'||NEW.id::text,'FUNDING',equity_baseline*NEW.allocation_target_percent/100,(extract(epoch FROM clock_timestamp())*1000)::bigint FROM exchange_accounts WHERE id=NEW.exchange_account_id;
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE paper_capital_ledger ADD CONSTRAINT paper_amount_finite CHECK(amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE paper_reservations ADD CONSTRAINT paper_capacity_finite CHECK(reserved::text NOT IN ('NaN','Infinity','-Infinity') AND committed::text NOT IN ('NaN','Infinity','-Infinity') AND notional::text NOT IN ('NaN','Infinity','-Infinity') AND stop_exposure::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE paper_marks ADD CONSTRAINT paper_mark_finite CHECK(price>0 AND price::text NOT IN ('NaN','Infinity','-Infinity'));
