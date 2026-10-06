package agentd

import (
	"strings"
	"testing"
)

func TestShellOfReadsOneUsersLine(t *testing.T) {
	passwd := "root:x:0:0:root:/root:/bin/bash\ndot:x:1000:1000:invisible_dots agent:/home/dot:/bin/zsh\nbad:line\n"
	if got := shellOf(passwd, "dot"); got != "/bin/zsh" {
		t.Errorf("dot: %q", got)
	}
	if got := shellOf(passwd, "nobody"); got != "" {
		t.Errorf("nobody: %q", got)
	}
}

func TestWithVariablesReplacesAndAdds(t *testing.T) {
	got := withVariables([]string{"A=1", "HOME=/x", "HOMEX=2", "B=3"}, "HOME=/y", "NEW=n")
	want := []string{"A=1", "HOMEX=2", "B=3", "HOME=/y", "NEW=n"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got %v", got)
	}
}

func TestExecEnvIsTheAccountsNotTheDaemons(t *testing.T) {
	t.Setenv("HOME", "/home/dotagentd")
	t.Setenv("USER", "dotagentd")
	t.Setenv("SHELL", "/usr/sbin/nologin")
	t.Setenv("PATH", "/usr/bin")
	srv := New(Options{Home: "/home/dot", Display: ":0", RunAs: &Account{Name: "dot", Shell: "/bin/bash"}})
	got := map[string]string{}
	for _, kv := range srv.execEnv() {
		name, value, _ := strings.Cut(kv, "=")
		if _, twice := got[name]; twice {
			t.Errorf("%s is set twice", name)
		}
		got[name] = value
	}
	for name, want := range map[string]string{
		"HOME": "/home/dot", "USER": "dot", "LOGNAME": "dot", "SHELL": "/bin/bash",
		"PATH": "/home/dot/.local/bin:" + SystemPath, "DISPLAY": ":0",
	} {
		if got[name] != want {
			t.Errorf("%s = %q, want %q", name, got[name], want)
		}
	}
}

// The model's PATH is built where the model's environment is, not taken from the daemon: the daemon's holds
// nothing the model can write, and whatever it holds, the model's commands get the Dot's.
func TestExecEnvPathDoesNotDependOnTheDaemonsPath(t *testing.T) {
	t.Setenv("PATH", "/somewhere/else:/usr/bin")
	srv := New(Options{Home: "/home/dot"})
	var paths []string
	for _, kv := range srv.execEnv() {
		if value, ok := strings.CutPrefix(kv, "PATH="); ok {
			paths = append(paths, value)
		}
	}
	if want := "/home/dot/.local/bin:" + SystemPath; len(paths) != 1 || paths[0] != want {
		t.Errorf("PATH %q, want one %q", paths, want)
	}
}
