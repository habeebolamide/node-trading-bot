CREATE TRIGGER closed_candle_immutable BEFORE UPDATE OR DELETE ON candles
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER instrument_version_immutable BEFORE UPDATE OR DELETE ON instrument_versions
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE INDEX market_gap_unresolved ON market_data_gaps (instrument_id,stream,start_time)
 WHERE status IN ('OPEN','UNCERTAIN');
