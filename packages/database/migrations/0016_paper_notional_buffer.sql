CREATE OR REPLACE FUNCTION check_paper_reservation_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r paper_reservations; t trade_lifecycles; unit numeric; outstanding numeric; open_qty numeric;
BEGIN
 IF TG_TABLE_NAME='trade_lifecycles' THEN
  IF NEW.execution_backend<>'PAPER' THEN RETURN NEW; END IF;
  SELECT * INTO r FROM paper_reservations WHERE trade_id=NEW.id;
 ELSE SELECT * INTO r FROM paper_reservations WHERE trade_id=NEW.trade_id;
 END IF;
 SELECT * INTO t FROM trade_lifecycles WHERE id=r.trade_id;
 unit:=((r.approval->>'margin')::numeric+(r.approval->>'buffer')::numeric)/(r.approval->>'quantity')::numeric;
 outstanding:=CASE WHEN t.entry_terminal THEN 0 ELSE t.requested_quantity-t.filled_quantity END;
 open_qty:=t.filled_quantity-t.closed_quantity;
 IF abs(r.reserved-trunc(outstanding*unit,18))>0.00000000000000001 OR abs(r.committed-trunc(open_qty*unit,18))>0.00000000000000001
 OR abs(r.notional-trunc((outstanding+open_qty)*(r.approval->>'notional')::numeric/(r.approval->>'quantity')::numeric,18))>0.00000000000000001 THEN RAISE EXCEPTION 'Capital reservation disagrees with durable exposure'; END IF;
 RETURN NEW;
END $$;
