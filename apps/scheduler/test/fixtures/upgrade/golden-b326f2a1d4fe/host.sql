--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id text NOT NULL,
    dot_id text NOT NULL,
    task_id text,
    tool text NOT NULL,
    permission text NOT NULL,
    arguments jsonb NOT NULL,
    reason text NOT NULL,
    status text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text])))
);


--
-- Name: channel_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_bindings (
    id text NOT NULL,
    dot_id text NOT NULL,
    kind text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    settings jsonb NOT NULL,
    status text NOT NULL,
    status_detail text,
    account text,
    event_cursor bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_bindings_event_cursor_check CHECK ((event_cursor >= 0)),
    CONSTRAINT channel_bindings_kind_check CHECK ((kind = ANY (ARRAY['telegram'::text, 'whatsapp'::text]))),
    CONSTRAINT channel_bindings_status_check CHECK ((status = ANY (ARRAY['connecting'::text, 'connected'::text, 'needs_relink'::text, 'error'::text])))
);


--
-- Name: channel_pairings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_pairings (
    binding_id text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone
);


--
-- Name: channel_peers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_peers (
    binding_id text NOT NULL,
    peer_id text NOT NULL,
    chat_id text NOT NULL,
    role text NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_peers_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'user'::text])))
);


--
-- Name: channel_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_prompts (
    binding_id text NOT NULL,
    approval_id text NOT NULL,
    chat_id text NOT NULL,
    ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: computers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computers (
    dot_id text NOT NULL,
    vm_name text NOT NULL,
    guest_port integer,
    pid integer,
    state text NOT NULL,
    golden_image text,
    runtime_image text,
    token_enc bytea NOT NULL,
    event_cursor bigint DEFAULT 0 NOT NULL,
    last_active_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    next_automation_at timestamp with time zone,
    stop_reason text,
    CONSTRAINT computers_guest_port_check CHECK (((guest_port >= 1) AND (guest_port <= 65535))),
    CONSTRAINT computers_pid_check CHECK ((pid > 0)),
    CONSTRAINT computers_state_check CHECK ((state = ANY (ARRAY['PROVISIONING'::text, 'STARTING'::text, 'RUNNING'::text, 'IDLE'::text, 'STOPPING'::text, 'STOPPED'::text, 'ERROR'::text, 'DELETING'::text]))),
    CONSTRAINT computers_stop_reason_check CHECK ((stop_reason = ANY (ARRAY['idle'::text, 'user'::text, 'exited'::text])))
);


--
-- Name: dots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dots (
    id text NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    status text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    config_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT dots_status_check CHECK ((status = ANY (ARRAY['CREATING'::text, 'READY'::text, 'IDLE'::text, 'RUNNING'::text, 'WAITING_APPROVAL'::text, 'ERROR'::text, 'DISABLED'::text])))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    dot_id text NOT NULL,
    type text NOT NULL,
    data jsonb NOT NULL,
    source text NOT NULL,
    guest_seq bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT events_check CHECK (((source = 'guest'::text) = (guest_seq IS NOT NULL))),
    CONSTRAINT events_source_check CHECK ((source = ANY (ARRAY['host'::text, 'guest'::text])))
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.events_id_seq OWNED BY public.events.id;


--
-- Name: inbound_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbound_events (
    seq bigint NOT NULL,
    id text NOT NULL,
    dot_id text NOT NULL,
    type text NOT NULL,
    data jsonb NOT NULL,
    ts text NOT NULL,
    task_id text,
    run_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    dropped_at timestamp with time zone,
    drop_reason text,
    failures integer DEFAULT 0 NOT NULL,
    last_error text,
    retry_at timestamp with time zone,
    CONSTRAINT inbound_events_type_check CHECK ((type = ANY (ARRAY['user.message'::text, 'task.created'::text, 'approval.received'::text, 'system.event'::text])))
);


--
-- Name: inbound_events_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inbound_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inbound_events_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inbound_events_seq_seq OWNED BY public.inbound_events.seq;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secrets (
    scope text NOT NULL,
    name text NOT NULL,
    value_enc bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_runs (
    id text NOT NULL,
    task_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    finished_at timestamp with time zone,
    outcome text
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id text NOT NULL,
    dot_id text NOT NULL,
    description text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    summary text,
    error text,
    spent_usd double precision DEFAULT 0 NOT NULL,
    CONSTRAINT tasks_spent_usd_check CHECK ((spent_usd >= (0)::double precision)),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'WAITING_APPROVAL'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])))
);


--
-- Name: events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);


--
-- Name: inbound_events seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_events ALTER COLUMN seq SET DEFAULT nextval('public.inbound_events_seq_seq'::regclass);


--
-- Data for Name: approvals; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.approvals VALUES ('apr_01m4ceepvn47ypbkcpd5cymdey', 'dot_01m4ceepkrt609r0tde6hm21hb', 'task_01m4ceeptfsmdeddevy4770sbk', 'browser_identity_delete', 'browser.identity.delete', '{"identity_id": "shop-abc123"}', 'the tool needs approval', 'approved', 'fine', '2026-10-08 00:26:18.038234+00', '2026-10-08 00:26:18.071102+00');
INSERT INTO public.approvals VALUES ('apr_01m4ceepzq74326e3e6vrheqvj', 'dot_01m4ceepkrt609r0tde6hm21hb', 'task_01m4ceepz48cetk8s7k7zwkst5', 'browser_identity_delete', 'browser.identity.delete', '{"identity_id": "shop-abc123"}', 'the tool needs approval', 'pending', NULL, '2026-10-08 00:26:18.153524+00', NULL);


--
-- Data for Name: channel_bindings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.channel_bindings VALUES ('chb_upgrade', 'dot_01m4ceepkrt609r0tde6hm21hb', 'telegram', true, '{"approvals": true, "notify_tasks": true, "show_arguments": false}', 'connecting', NULL, 'fare_watch_bot', 0, '2026-10-08 00:26:18.181416+00');


--
-- Data for Name: channel_pairings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: channel_peers; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.channel_peers VALUES ('chb_upgrade', '4242', '4242', 'owner', 'Federico', '2026-10-08 00:26:18.187194+00');


--
-- Data for Name: channel_prompts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: computers; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.computers VALUES ('dot_01m4ceepkrt609r0tde6hm21hb', 'invisible-dot-dot_01m4ceepkrt609r0tde6hm21hb', 47000, 9000, 'RUNNING', 'images/golden-test.qcow2', 'images/runtime-test.iso', '\xd8f1c54703e75012cfac1404e670ebfdb057db12ea08404cd0e3b7367c02826ead80d0e36069ab2c190ee026c9ef5059590e1c32c10d787db872b944b7da832b635e4b9117ced9', 16, '2026-10-07 09:00:00+00', NULL, '2026-10-08 00:26:18.181416+00', '2026-10-09 00:23:53.167+00', NULL);
INSERT INTO public.computers VALUES ('dot_01m4ceeq1d5fgv96gmxs71ht30', 'invisible-dot-dot_01m4ceeq1d5fgv96gmxs71ht30', NULL, NULL, 'STOPPED', 'images/golden-test.qcow2', 'images/runtime-test.iso', '\x292befaaec6513a1a36ee6a6efa250c5eaba66e80bc9c2e7bca66bf26f3ece3c52f63b6c00d9eaec7a44d828176b1994b779f5cc635738a95529d12917459e3b65ed4a130f74d4', 1, '2026-10-07 09:00:00+00', NULL, '2026-10-08 00:26:18.281007+00', NULL, 'user');


--
-- Data for Name: dots; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.dots VALUES ('dot_01m4ceepkrt609r0tde6hm21hb', 'fare-watch', '{"name": "fare-watch", "model": {"id": "z-ai/glm-5.3-flash", "provider": "openrouter"}, "limits": {"context_tokens": 32000, "max_steps_per_task": 60, "max_cost_per_task_usd": 1}, "models": {}, "computer": {"cpu": 2, "disk": "40gb", "memory": "4gb", "idle_timeout": "15m"}, "permissions": {"files.write": "ask"}}', 'WAITING_APPROVAL', NULL, '2026-10-08 00:26:17.77945+00', '2026-10-08 00:26:18.145257+00', 3);
INSERT INTO public.dots VALUES ('dot_01m4ceeq1d5fgv96gmxs71ht30', 'minimal-dot', '{"name": "minimal-dot", "model": {"id": "z-ai/glm-5.3-flash", "provider": "openrouter"}, "limits": {"context_tokens": 32000, "max_steps_per_task": 60, "max_cost_per_task_usd": 1}, "models": {}, "computer": {"cpu": 2, "disk": "40gb", "memory": "4gb", "idle_timeout": "15m"}, "permissions": {"files.write": "ask"}}', 'IDLE', NULL, '2026-10-08 00:26:18.190622+00', '2026-10-08 00:26:18.281007+00', 1);


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.events VALUES (1, 'dot_01m4ceepkrt609r0tde6hm21hb', 'dot.created', '{"name": "fare-watch"}', 'host', NULL, '2026-10-08 00:26:17.77945+00');
INSERT INTO public.events VALUES (2, 'dot_01m4ceepkrt609r0tde6hm21hb', 'computer.state', '{"state": "PROVISIONING"}', 'host', NULL, '2026-10-08 00:26:17.77945+00');
INSERT INTO public.events VALUES (3, 'dot_01m4ceepkrt609r0tde6hm21hb', 'computer.state', '{"state": "STARTING"}', 'host', NULL, '2026-10-08 00:26:17.815323+00');
INSERT INTO public.events VALUES (4, 'dot_01m4ceepkrt609r0tde6hm21hb', 'computer.state', '{"state": "RUNNING"}', 'host', NULL, '2026-10-08 00:26:17.823904+00');
INSERT INTO public.events VALUES (5, 'dot_01m4ceepkrt609r0tde6hm21hb', 'computer.started', '{"guest_port": 47000, "runtime_image": "images/runtime-test.iso"}', 'host', NULL, '2026-10-08 00:26:17.823904+00');
INSERT INTO public.events VALUES (6, 'dot_01m4ceepkrt609r0tde6hm21hb', 'agent.started', '{"guest_ts": "2026-10-08T00:26:17.640Z", "guest_event_id": "evt_01m4ceepn88vyrgn8zp99tx0zz"}', 'guest', 1, '2026-10-08 00:26:17.862351+00');
INSERT INTO public.events VALUES (7, 'dot_01m4ceepkrt609r0tde6hm21hb', 'user.message', '{"text": "Remember: my favourite colour is teal.", "message_id": "msg_01m4ceepq4w4wdyp8tvy7v060r"}', 'host', NULL, '2026-10-08 00:26:17.880657+00');
INSERT INTO public.events VALUES (8, 'dot_01m4ceepkrt609r0tde6hm21hb', 'message.assistant', '{"text": "echo: Remember: my favourite colour is teal.", "guest_ts": "2026-10-08T00:26:17.720Z", "in_reply_to": "msg_01m4ceepq4w4wdyp8tvy7v060r", "guest_event_id": "evt_01m4ceepqrxs5240rvb8cmrtee"}', 'guest', 2, '2026-10-08 00:26:17.899743+00');
INSERT INTO public.events VALUES (9, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.created', '{"task_id": "task_01m4ceepr4pcpyejkrwmwszmvy", "priority": 0, "description": "List the workspace."}', 'host', NULL, '2026-10-08 00:26:17.910436+00');
INSERT INTO public.events VALUES (10, 'dot_01m4ceepkrt609r0tde6hm21hb', 'agent.state', '{"state": "THINKING", "guest_ts": "2026-10-08T00:26:17.763Z", "guest_event_id": "evt_01m4ceeps3b18qmjz7x3acqxr7"}', 'guest', 3, '2026-10-08 00:26:17.940112+00');
INSERT INTO public.events VALUES (11, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.started', '{"task_id": "task_01m4ceepr4pcpyejkrwmwszmvy", "guest_ts": "2026-10-08T00:26:17.763Z", "guest_event_id": "evt_01m4ceeps31c9j93jpd8nb3gz9"}', 'guest', 4, '2026-10-08 00:26:17.948021+00');
INSERT INTO public.events VALUES (12, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.completed', '{"summary": "done: List the workspace.", "task_id": "task_01m4ceepr4pcpyejkrwmwszmvy", "guest_ts": "2026-10-08T00:26:17.763Z", "guest_event_id": "evt_01m4ceeps3hawexcrf77xqs9wq"}', 'guest', 5, '2026-10-08 00:26:17.956503+00');
INSERT INTO public.events VALUES (13, 'dot_01m4ceepkrt609r0tde6hm21hb', 'agent.state', '{"state": "IDLE", "guest_ts": "2026-10-08T00:26:17.763Z", "guest_event_id": "evt_01m4ceeps3parat5eey42mqgsj"}', 'guest', 6, '2026-10-08 00:26:17.966985+00');
INSERT INTO public.events VALUES (14, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.created', '{"task_id": "task_01m4ceeptfsmdeddevy4770sbk", "priority": 0, "description": "Delete the old identity."}', 'host', NULL, '2026-10-08 00:26:17.981828+00');
INSERT INTO public.events VALUES (15, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.started', '{"task_id": "task_01m4ceeptfsmdeddevy4770sbk", "guest_ts": "2026-10-08T00:26:17.845Z", "guest_event_id": "evt_01m4ceepvn3vzncer00rmzep10"}', 'guest', 7, '2026-10-08 00:26:18.018234+00');
INSERT INTO public.events VALUES (16, 'dot_01m4ceepkrt609r0tde6hm21hb', 'agent.state', '{"state": "WAITING_APPROVAL", "guest_ts": "2026-10-08T00:26:17.845Z", "guest_event_id": "evt_01m4ceepvnc1nwxjjf3q3w032b"}', 'guest', 8, '2026-10-08 00:26:18.029602+00');
INSERT INTO public.events VALUES (17, 'dot_01m4ceepkrt609r0tde6hm21hb', 'approval.requested', '{"tool": "browser_identity_delete", "reason": "the tool needs approval", "task_id": "task_01m4ceeptfsmdeddevy4770sbk", "guest_ts": "2026-10-08T00:26:17.845Z", "arguments": {"identity_id": "shop-abc123"}, "permission": "browser.identity.delete", "approval_id": "apr_01m4ceepvn47ypbkcpd5cymdey", "guest_event_id": "evt_01m4ceepvnz1rg79k8y3p2hh5g"}', 'guest', 9, '2026-10-08 00:26:18.038234+00');
INSERT INTO public.events VALUES (18, 'dot_01m4ceepkrt609r0tde6hm21hb', 'approval.resolved', '{"note": "fine", "always": true, "task_id": "task_01m4ceeptfsmdeddevy4770sbk", "decision": "approve", "approval_id": "apr_01m4ceepvn47ypbkcpd5cymdey"}', 'host', NULL, '2026-10-08 00:26:18.071102+00');
INSERT INTO public.events VALUES (19, 'dot_01m4ceepkrt609r0tde6hm21hb', 'dot.updated', '{"name": "fare-watch"}', 'host', NULL, '2026-10-08 00:26:18.071102+00');
INSERT INTO public.events VALUES (20, 'dot_01m4ceepkrt609r0tde6hm21hb', 'agent.state', '{"state": "EXECUTING", "guest_ts": "2026-10-08T00:26:17.924Z", "guest_event_id": "evt_01m4ceepy4fbsgfqd96zgj6t4v"}', 'guest', 10, '2026-10-08 00:26:18.091455+00');
INSERT INTO public.events VALUES (21, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.completed', '{"summary": "approval approved", "task_id": "task_01m4ceeptfsmdeddevy4770sbk", "guest_ts": "2026-10-08T00:26:17.924Z", "guest_event_id": "evt_01m4ceepy4ea0fjr9b6g6kpk29"}', 'guest', 11, '2026-10-08 00:26:18.100452+00');
INSERT INTO public.events VALUES (22, 'dot_01m4ceepkrt609r0tde6hm21hb', 'agent.state', '{"state": "IDLE", "guest_ts": "2026-10-08T00:26:17.924Z", "guest_event_id": "evt_01m4ceepy48vx98jjv03q60ajm"}', 'guest', 12, '2026-10-08 00:26:18.107693+00');
INSERT INTO public.events VALUES (23, 'dot_01m4ceepkrt609r0tde6hm21hb', 'dot.updated', '{"name": "fare-watch"}', 'host', NULL, '2026-10-08 00:26:18.111019+00');
INSERT INTO public.events VALUES (24, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.created', '{"task_id": "task_01m4ceepz48cetk8s7k7zwkst5", "priority": 0, "description": "Delete the shop identity."}', 'host', NULL, '2026-10-08 00:26:18.121808+00');
INSERT INTO public.events VALUES (25, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.started', '{"task_id": "task_01m4ceepz48cetk8s7k7zwkst5", "guest_ts": "2026-10-08T00:26:17.975Z", "guest_event_id": "evt_01m4ceepzqq05k889g7kweerrc"}', 'guest', 13, '2026-10-08 00:26:18.139836+00');
INSERT INTO public.events VALUES (26, 'dot_01m4ceepkrt609r0tde6hm21hb', 'agent.state', '{"state": "WAITING_APPROVAL", "guest_ts": "2026-10-08T00:26:17.975Z", "guest_event_id": "evt_01m4ceepzqxj1pzcgx1zba0mcr"}', 'guest', 14, '2026-10-08 00:26:18.145257+00');
INSERT INTO public.events VALUES (27, 'dot_01m4ceepkrt609r0tde6hm21hb', 'approval.requested', '{"tool": "browser_identity_delete", "reason": "the tool needs approval", "task_id": "task_01m4ceepz48cetk8s7k7zwkst5", "guest_ts": "2026-10-08T00:26:17.975Z", "arguments": {"identity_id": "shop-abc123"}, "permission": "browser.identity.delete", "approval_id": "apr_01m4ceepzq74326e3e6vrheqvj", "guest_event_id": "evt_01m4ceepzq7pb07ekz37zhskey"}', 'guest', 15, '2026-10-08 00:26:18.153524+00');
INSERT INTO public.events VALUES (28, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.created', '{"task_id": "task_01m4ceeq0s2zdfycr7vwnwy9s8", "priority": 0, "description": "Check the fares again."}', 'host', NULL, '2026-10-08 00:26:18.171462+00');
INSERT INTO public.events VALUES (29, 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.cancelled', '{"task_id": "task_01m4ceeq0s2zdfycr7vwnwy9s8"}', 'host', NULL, '2026-10-08 00:26:18.176182+00');
INSERT INTO public.events VALUES (30, 'dot_01m4ceepkrt609r0tde6hm21hb', 'automation.next_run', '{"guest_ts": "2026-10-08T00:26:18.019Z", "guest_event_id": "evt_01m4ceeq13g8b426wcn3432mbv", "next_run_at_ms": 1791505433167}', 'guest', 16, '2026-10-08 00:26:18.181416+00');
INSERT INTO public.events VALUES (31, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'dot.created', '{"name": "minimal-dot"}', 'host', NULL, '2026-10-08 00:26:18.190622+00');
INSERT INTO public.events VALUES (32, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'computer.state', '{"state": "PROVISIONING"}', 'host', NULL, '2026-10-08 00:26:18.190622+00');
INSERT INTO public.events VALUES (33, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'computer.state', '{"state": "STARTING"}', 'host', NULL, '2026-10-08 00:26:18.203391+00');
INSERT INTO public.events VALUES (34, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'computer.state', '{"state": "RUNNING"}', 'host', NULL, '2026-10-08 00:26:18.208314+00');
INSERT INTO public.events VALUES (35, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'computer.started', '{"guest_port": 47001, "runtime_image": "images/runtime-test.iso"}', 'host', NULL, '2026-10-08 00:26:18.208314+00');
INSERT INTO public.events VALUES (36, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'agent.started', '{"guest_ts": "2026-10-08T00:26:18.048Z", "guest_event_id": "evt_01m4ceeq206y59sjefjm80tgar"}', 'guest', 1, '2026-10-08 00:26:18.237511+00');
INSERT INTO public.events VALUES (37, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'computer.state', '{"state": "STOPPING"}', 'host', NULL, '2026-10-08 00:26:18.260481+00');
INSERT INTO public.events VALUES (38, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'computer.state', '{"state": "STOPPED"}', 'host', NULL, '2026-10-08 00:26:18.281007+00');
INSERT INTO public.events VALUES (39, 'dot_01m4ceeq1d5fgv96gmxs71ht30', 'computer.stopped', '{"forced": false, "reason": "user"}', 'host', NULL, '2026-10-08 00:26:18.281007+00');


--
-- Data for Name: inbound_events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.inbound_events VALUES (1, 'msg_01m4ceepq4w4wdyp8tvy7v060r', 'dot_01m4ceepkrt609r0tde6hm21hb', 'user.message', '{"text": "Remember: my favourite colour is teal."}', '2026-10-07T09:00:00.000Z', NULL, NULL, '2026-10-08 00:26:17.880657+00', '2026-10-08 00:26:17.892461+00', '2026-10-08 00:26:17.899719+00', NULL, NULL, 0, NULL, NULL);
INSERT INTO public.inbound_events VALUES (2, 'evt_01m4ceeprmq0dfftt3ejd0v7qc', 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.created', '{"task_id": "task_01m4ceepr4pcpyejkrwmwszmvy", "priority": 0, "description": "List the workspace."}', '2026-10-07T09:00:00.000Z', 'task_01m4ceepr4pcpyejkrwmwszmvy', 'run_01m4ceeprj3zwtyjmrn8wpefzz', '2026-10-08 00:26:17.918409+00', '2026-10-08 00:26:17.933733+00', '2026-10-08 00:26:17.940076+00', NULL, NULL, 0, NULL, NULL);
INSERT INTO public.inbound_events VALUES (3, 'evt_01m4ceepv0asgrb9zz7j54fjsp', 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.created', '{"task_id": "task_01m4ceeptfsmdeddevy4770sbk", "priority": 0, "description": "Delete the old identity."}', '2026-10-07T09:00:00.000Z', 'task_01m4ceeptfsmdeddevy4770sbk', 'run_01m4ceeptymc59t9c34rmqzq8v', '2026-10-08 00:26:17.989407+00', '2026-10-08 00:26:18.010516+00', '2026-10-08 00:26:18.018374+00', NULL, NULL, 0, NULL, NULL);
INSERT INTO public.inbound_events VALUES (4, 'evt_01m4ceepxe33m1qnqvsfbzvkvc', 'dot_01m4ceepkrt609r0tde6hm21hb', 'approval.received', '{"note": "fine", "decision": "approve", "approval_id": "apr_01m4ceepvn47ypbkcpd5cymdey"}', '2026-10-07T09:00:00.000Z', NULL, NULL, '2026-10-08 00:26:18.071102+00', '2026-10-08 00:26:18.087155+00', '2026-10-08 00:26:18.091459+00', NULL, NULL, 0, NULL, NULL);
INSERT INTO public.inbound_events VALUES (5, 'evt_01m4ceepzer7yzzxfn4t1hwway', 'dot_01m4ceepkrt609r0tde6hm21hb', 'task.created', '{"task_id": "task_01m4ceepz48cetk8s7k7zwkst5", "priority": 0, "description": "Delete the shop identity."}', '2026-10-07T09:00:00.000Z', 'task_01m4ceepz48cetk8s7k7zwkst5', 'run_01m4ceepzd75vf6eyq6s83tvxf', '2026-10-08 00:26:18.126436+00', '2026-10-08 00:26:18.135244+00', '2026-10-08 00:26:18.139817+00', NULL, NULL, 0, NULL, NULL);


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_migrations VALUES ('0001_initial', '2026-10-08 00:26:17.623866+00');
INSERT INTO public.schema_migrations VALUES ('0002_inbound_events', '2026-10-08 00:26:17.666723+00');
INSERT INTO public.schema_migrations VALUES ('0003_task_spend', '2026-10-08 00:26:17.680464+00');
INSERT INTO public.schema_migrations VALUES ('0004_channels', '2026-10-08 00:26:17.688232+00');
INSERT INTO public.schema_migrations VALUES ('0005_channel_prompts', '2026-10-08 00:26:17.707123+00');
INSERT INTO public.schema_migrations VALUES ('0006_events_task', '2026-10-08 00:26:17.718165+00');
INSERT INTO public.schema_migrations VALUES ('0007_dot_config_version', '2026-10-08 00:26:17.724644+00');
INSERT INTO public.schema_migrations VALUES ('0008_computer_next_automation', '2026-10-08 00:26:17.730628+00');
INSERT INTO public.schema_migrations VALUES ('0009_dot_keeps_its_memory', '2026-10-08 00:26:17.737384+00');
INSERT INTO public.schema_migrations VALUES ('0010_dot_has_no_goal', '2026-10-08 00:26:17.745491+00');
INSERT INTO public.schema_migrations VALUES ('0011_dot_has_no_browser_settings', '2026-10-08 00:26:17.753326+00');


--
-- Data for Name: secrets; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.secrets VALUES ('global', 'openrouter_api_key', '\x83ecec4851c227f6a0848b8123934629df0b90a2a63abc4b38d243360f1593e3604f9658463bada064baf61238436101953919de8d0551c0946b3f7cb6adbefbbf3da3', '2026-10-08 00:26:17.762727+00');
INSERT INTO public.secrets VALUES ('dot_01m4ceepkrt609r0tde6hm21hb', 'telegram_bot_token', '\xcb8b7dc5772170ab2190e83956526daf3705cd174d2c1d80cffa2d1dcd5709736fbde9a872341e083d0586749322d18eeede5662b8b012c46505bd92aba13e6a8417a8', '2026-10-08 00:26:18.184962+00');


--
-- Data for Name: task_runs; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.task_runs VALUES ('run_01m4ceeprj3zwtyjmrn8wpefzz', 'task_01m4ceepr4pcpyejkrwmwszmvy', '2026-10-08 00:26:17.918409+00', '2026-10-08 00:26:17.942498+00', '2026-10-08 00:26:17.956503+00', 'completed');
INSERT INTO public.task_runs VALUES ('run_01m4ceeptymc59t9c34rmqzq8v', 'task_01m4ceeptfsmdeddevy4770sbk', '2026-10-08 00:26:17.989407+00', '2026-10-08 00:26:18.023517+00', '2026-10-08 00:26:18.100452+00', 'completed');
INSERT INTO public.task_runs VALUES ('run_01m4ceepzd75vf6eyq6s83tvxf', 'task_01m4ceepz48cetk8s7k7zwkst5', '2026-10-08 00:26:18.126436+00', '2026-10-08 00:26:18.14187+00', NULL, NULL);


--
-- Data for Name: tasks; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.tasks VALUES ('task_01m4ceepr4pcpyejkrwmwszmvy', 'dot_01m4ceepkrt609r0tde6hm21hb', 'List the workspace.', 0, 'COMPLETED', '2026-10-08 00:26:17.910436+00', NULL, '2026-10-08 00:26:17.918409+00', '2026-10-08 00:26:17.956503+00', 'done: List the workspace.', NULL, 0);
INSERT INTO public.tasks VALUES ('task_01m4ceeptfsmdeddevy4770sbk', 'dot_01m4ceepkrt609r0tde6hm21hb', 'Delete the old identity.', 0, 'COMPLETED', '2026-10-08 00:26:17.981828+00', NULL, '2026-10-08 00:26:17.989407+00', '2026-10-08 00:26:18.100452+00', 'approval approved', NULL, 0);
INSERT INTO public.tasks VALUES ('task_01m4ceepz48cetk8s7k7zwkst5', 'dot_01m4ceepkrt609r0tde6hm21hb', 'Delete the shop identity.', 0, 'WAITING_APPROVAL', '2026-10-08 00:26:18.121808+00', NULL, '2026-10-08 00:26:18.126436+00', NULL, NULL, NULL, 0);
INSERT INTO public.tasks VALUES ('task_01m4ceeq0s2zdfycr7vwnwy9s8', 'dot_01m4ceepkrt609r0tde6hm21hb', 'Check the fares again.', 0, 'CANCELLED', '2026-10-08 00:26:18.171462+00', NULL, NULL, '2026-10-08 00:26:18.176182+00', NULL, 'cancelled by the user', 0);


--
-- Name: events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.events_id_seq', 39, true);


--
-- Name: inbound_events_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.inbound_events_seq_seq', 5, true);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: channel_bindings channel_bindings_dot_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_bindings
    ADD CONSTRAINT channel_bindings_dot_id_kind_key UNIQUE (dot_id, kind);


--
-- Name: channel_bindings channel_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_bindings
    ADD CONSTRAINT channel_bindings_pkey PRIMARY KEY (id);


--
-- Name: channel_pairings channel_pairings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_pairings
    ADD CONSTRAINT channel_pairings_pkey PRIMARY KEY (binding_id, code_hash);


--
-- Name: channel_peers channel_peers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_peers
    ADD CONSTRAINT channel_peers_pkey PRIMARY KEY (binding_id, peer_id);


--
-- Name: channel_prompts channel_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_prompts
    ADD CONSTRAINT channel_prompts_pkey PRIMARY KEY (binding_id, approval_id, chat_id);


--
-- Name: computers computers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computers
    ADD CONSTRAINT computers_pkey PRIMARY KEY (dot_id);


--
-- Name: dots dots_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dots
    ADD CONSTRAINT dots_name_key UNIQUE (name);


--
-- Name: dots dots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dots
    ADD CONSTRAINT dots_pkey PRIMARY KEY (id);


--
-- Name: events events_dot_id_guest_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_dot_id_guest_seq_key UNIQUE (dot_id, guest_seq);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: inbound_events inbound_events_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_events
    ADD CONSTRAINT inbound_events_id_key UNIQUE (id);


--
-- Name: inbound_events inbound_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_events
    ADD CONSTRAINT inbound_events_pkey PRIMARY KEY (seq);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: secrets secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (scope, name);


--
-- Name: task_runs task_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_runs
    ADD CONSTRAINT task_runs_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: approvals_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_status_idx ON public.approvals USING btree (status, created_at);


--
-- Name: channel_bindings_account_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channel_bindings_account_key ON public.channel_bindings USING btree (account) WHERE ((kind = 'telegram'::text) AND (account IS NOT NULL));


--
-- Name: channel_peers_chat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_peers_chat_idx ON public.channel_peers USING btree (binding_id, chat_id);


--
-- Name: channel_prompts_approval_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_prompts_approval_idx ON public.channel_prompts USING btree (approval_id);


--
-- Name: events_dot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_dot_idx ON public.events USING btree (dot_id, id);


--
-- Name: events_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_task_idx ON public.events USING btree (dot_id, ((data ->> 'task_id'::text)), id) WHERE ((data ->> 'task_id'::text) IS NOT NULL);


--
-- Name: events_user_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_user_message_idx ON public.events USING btree (dot_id, ((data ->> 'message_id'::text))) WHERE (type = 'user.message'::text);


--
-- Name: events_user_message_origin_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX events_user_message_origin_key ON public.events USING btree (dot_id, (((data -> 'origin'::text) ->> 'binding_id'::text)), (((data -> 'origin'::text) ->> 'external_id'::text))) WHERE ((type = 'user.message'::text) AND ((data -> 'origin'::text) IS NOT NULL));


--
-- Name: inbound_events_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_events_pending_idx ON public.inbound_events USING btree (dot_id, seq) WHERE ((delivered_at IS NULL) AND (dropped_at IS NULL));


--
-- Name: task_runs_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_runs_task_idx ON public.task_runs USING btree (task_id);


--
-- Name: tasks_dot_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_dot_status_idx ON public.tasks USING btree (dot_id, status);


--
-- Name: tasks_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_pending_idx ON public.tasks USING btree (priority DESC, created_at, id) WHERE (status = 'PENDING'::text);


--
-- Name: approvals approvals_dot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_dot_id_fkey FOREIGN KEY (dot_id) REFERENCES public.dots(id) ON DELETE CASCADE;


--
-- Name: channel_bindings channel_bindings_dot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_bindings
    ADD CONSTRAINT channel_bindings_dot_id_fkey FOREIGN KEY (dot_id) REFERENCES public.dots(id) ON DELETE CASCADE;


--
-- Name: channel_pairings channel_pairings_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_pairings
    ADD CONSTRAINT channel_pairings_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.channel_bindings(id) ON DELETE CASCADE;


--
-- Name: channel_peers channel_peers_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_peers
    ADD CONSTRAINT channel_peers_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.channel_bindings(id) ON DELETE CASCADE;


--
-- Name: channel_prompts channel_prompts_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_prompts
    ADD CONSTRAINT channel_prompts_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.approvals(id) ON DELETE CASCADE;


--
-- Name: channel_prompts channel_prompts_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_prompts
    ADD CONSTRAINT channel_prompts_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.channel_bindings(id) ON DELETE CASCADE;


--
-- Name: computers computers_dot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computers
    ADD CONSTRAINT computers_dot_id_fkey FOREIGN KEY (dot_id) REFERENCES public.dots(id) ON DELETE CASCADE;


--
-- Name: inbound_events inbound_events_dot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_events
    ADD CONSTRAINT inbound_events_dot_id_fkey FOREIGN KEY (dot_id) REFERENCES public.dots(id) ON DELETE CASCADE;


--
-- Name: task_runs task_runs_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_runs
    ADD CONSTRAINT task_runs_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_dot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_dot_id_fkey FOREIGN KEY (dot_id) REFERENCES public.dots(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


