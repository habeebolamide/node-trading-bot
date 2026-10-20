CREATE TRIGGER service_scope BEFORE INSERT OR UPDATE ON strategy_evaluations FOR EACH ROW EXECUTE FUNCTION enforce_service_scope();
