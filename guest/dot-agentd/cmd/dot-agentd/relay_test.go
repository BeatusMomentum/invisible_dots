package main

import (
	"os"
	"strings"
	"testing"
)

func TestRelayFlags(t *testing.T) {
	env := envFlags{}
	if err := env.Set("A=b=c"); err != nil || env["A"] != "b=c" {
		t.Fatalf("env %v, err %v", env, err)
	}
	if err := env.Set("novalue"); err == nil {
		t.Error("an --env without = must be refused")
	}
	var names envFromFlags
	if err := names.Set("SECRET"); err != nil || len(names) != 1 || names[0] != "SECRET" {
		t.Fatalf("env-from %v, err %v", names, err)
	}
	for _, bad := range []string{"", "A=hunter2"} {
		err := names.Set(bad)
		if err == nil {
			t.Errorf("an --env-from of %q must be refused", bad)
		} else if strings.Contains(err.Error(), "hunter2") {
			t.Errorf("the refusal echoes the value: %v", err)
		}
	}
	if code := runRelay([]string{"--socket", "/nonexistent/agentd.sock"}); code != 2 {
		t.Errorf("no program: exit %d, want 2", code)
	}
	if code := runRelay([]string{"--socket", "/nonexistent/agentd.sock", "--", "true"}); code != 255 {
		t.Errorf("no daemon: exit %d, want 255", code)
	}
}

func TestForwardEnvReadsTheValuesFromTheEnvironmentAndNeverFromArguments(t *testing.T) {
	t.Setenv("DOT_TEST_SECRET", "http://user:hunter2@proxy.test:8080")
	env := envFlags{"KEEP": "1"}
	if err := forwardEnv(env, []string{"DOT_TEST_SECRET"}, os.LookupEnv); err != nil {
		t.Fatal(err)
	}
	if env["DOT_TEST_SECRET"] != "http://user:hunter2@proxy.test:8080" || env["KEEP"] != "1" {
		t.Errorf("env %v", env)
	}
	err := forwardEnv(env, []string{"DOT_TEST_UNSET_VARIABLE"}, os.LookupEnv)
	if err == nil || !strings.Contains(err.Error(), "DOT_TEST_UNSET_VARIABLE") {
		t.Errorf("an unset variable must be refused by name, got %v", err)
	}
	// Through the command: an unset variable is a usage error (2), before any daemon is asked.
	if code := runRelay([]string{"--socket", "/nonexistent/agentd.sock", "--env-from", "DOT_TEST_UNSET_VARIABLE", "--", "true"}); code != 2 {
		t.Errorf("unset --env-from: exit %d, want 2", code)
	}
}
