INSERT INTO lms_notification_control(id,importing) VALUES(1,0);
INSERT INTO lms_storage_state(id,revision) VALUES(1,0);
CREATE FUNCTION ax_storage_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE lms_storage_state SET revision=revision+1 WHERE id=1; RETURN NULL; END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['mentors','slots','bookings','panels','slot_templates','blocked_dates','reminders','qa_alerts','blocked_weekdays','onboarding_progress','assignments','submissions','assignment_panels','assignment_reminders','peer_eval_rounds','peer_evaluations'] LOOP
    EXECUTE format('CREATE TRIGGER storage_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ax_storage_revision()',name);
  END LOOP;
END $$;
CREATE FUNCTION ax_submission_alert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT importing FROM lms_notification_control WHERE id=1)=0 THEN
    INSERT INTO lms_outbox(id,event_key,kind,source_id,payload,actor,created_at)
    VALUES(replace(gen_random_uuid()::text,'-',''),'submission:' || NEW.id,'submission',NEW.assignment_id::text,
      json_build_object('title','새 과제 제출','description',substr((SELECT title FROM assignments WHERE id=NEW.assignment_id),1,200) || chr(10) || '제출자: ' || substr(NEW.user_name,1,200) || chr(10) || '팀: ' || substr(NEW.team,1,100) || chr(10) || '제출 시각 (UTC): ' || NEW.submitted_at,'assignmentId',NEW.assignment_id,'submissionId',NEW.id)::text,
      'submission',floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
    INSERT INTO lms_submission_targets(submission_id,target_key)
      SELECT NEW.id,CASE WHEN a.type='individual' THEN 'user:' || NEW.user_id ELSE 'team:' || t.id END
      FROM assignments a LEFT JOIN lms_assignment_courses c ON c.assignment_id=a.id
      LEFT JOIN lms_records t ON t.kind='teams' AND json_extract(t.data,'$.courseId')=c.course_id AND json_extract(t.data,'$.name')=NEW.team
      WHERE a.id=NEW.assignment_id AND (a.type='individual' OR t.id IS NOT NULL) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lms_submission_alert AFTER INSERT ON submissions FOR EACH ROW EXECUTE FUNCTION ax_submission_alert();
