CREATE UNIQUE INDEX one_entry_action_per_lifecycle ON runtime_actions(trade_id) WHERE kind='ENTRY';
CREATE UNIQUE INDEX one_inflight_close_per_lifecycle ON runtime_actions(trade_id)
 WHERE kind='CLOSE' AND state IN ('CREATED','SUBMITTING','OPEN','UNKNOWN');
CREATE UNIQUE INDEX one_inflight_protection_per_lifecycle ON runtime_actions(trade_id)
 WHERE kind IN ('PROTECT','AMEND_STOP') AND state IN ('CREATED','SUBMITTING','OPEN','UNKNOWN');
