ALTER TABLE exam_activity_events
  DROP CONSTRAINT exam_activity_events_event_type_check;

ALTER TABLE exam_activity_events
  ADD CONSTRAINT exam_activity_events_event_type_check
  CHECK (event_type IN (
    'tab_hidden', 'window_blur', 'fullscreen_exit', 'print_screen', 'app_closed'
  ));
