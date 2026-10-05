package main

import "testing"

func TestRelayFlags(t *testing.T) {
	env := envFlags{}
	if err := env.Set("A=b=c"); err != nil || env["A"] != "b=c" {
		t.Fatalf("env %v, err %v", env, err)
	}
	if err := env.Set("novalue"); err == nil {
		t.Error("an --env without = must be refused")
	}
	if code := runRelay([]string{"--socket", "/nonexistent/agentd.sock"}); code != 2 {
		t.Errorf("no program: exit %d, want 2", code)
	}
	if code := runRelay([]string{"--socket", "/nonexistent/agentd.sock", "--", "true"}); code != 255 {
		t.Errorf("no daemon: exit %d, want 255", code)
	}
}
