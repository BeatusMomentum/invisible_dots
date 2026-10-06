// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStreamProvider } from "../src/components/events";
import { NewDotPage } from "../src/components/new-dot/NewDotPage";
import { AttentionProvider } from "../src/components/shell/attention";
import { stubMatchMedia } from "./support/browser";
import { dotRecord, FakeControlPlane } from "./support/control-plane";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: () => "/new", useRouter: () => ({ push, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  push.mockClear();
  plane = new FakeControlPlane();
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderPage() {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <NewDotPage />
      </AttentionProvider>
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { name: "Create a Dot" });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
}

async function fillIdentity(name = "fare-watch", goal = "Watch the fares from Milan to Lisbon") {
  await userEvent.type(screen.getByLabelText("Name"), name);
  await userEvent.type(screen.getByLabelText("Goal"), goal);
}

describe("Create a Dot: the form", () => {
  it("has the three steps, with the defaults of the schema", async () => {
    await renderPage();
    for (const step of ["Identity", "Brain", "Computer and safety"]) expect(screen.getByRole("heading", { name: step })).toBeTruthy();
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("z-ai/glm-5.3-flash");
    expect((screen.getByLabelText("Processors") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Memory") as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText("Disk") as HTMLInputElement).value).toBe("40");
    expect((screen.getByLabelText("Sleep after") as HTMLSelectElement).value).toBe("15m");
    expect((screen.getByLabelText("Spending cap per task") as HTMLInputElement).value).toBe("1");
    expect((screen.getByRole("radio", { name: /Balanced/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("gives the sliders the schema's bounds", async () => {
    await renderPage();
    const bounds = (label: string) => {
      const slider = screen.getByLabelText(label) as HTMLInputElement;
      return [Number(slider.min), Number(slider.max)];
    };
    expect(bounds("Processors")).toEqual([1, 16]);
    expect(bounds("Memory")).toEqual([2, 64]);
    expect(bounds("Disk")).toEqual([20, 1024]);
  });

  it("creates the Dot with what the form shows, and opens its chat", async () => {
    await renderPage();
    await fillIdentity();
    await userEvent.type(screen.getByLabelText(/Instructions/), "Write to fares.csv.");
    fireEvent.change(screen.getByLabelText("Processors"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "8" } });
    await userEvent.selectOptions(screen.getByLabelText("Sleep after"), "30m");
    await userEvent.click(screen.getByRole("button", { name: "Create Dot" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dots/created-1/chat"));
    expect(plane.created).toEqual([
      {
        name: "fare-watch",
        goal: "Watch the fares from Milan to Lisbon",
        instructions: "Write to fares.csv.",
        model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
        computer: { cpu: 4, memory: "8gb", disk: "40gb", idle_timeout: "30m" },
        permissions: {},
        limits: { max_cost_per_task_usd: 1 },
      },
    ]);
  });

  it("sends the preset that was chosen as the permissions", async () => {
    await renderPage();
    await fillIdentity();
    await userEvent.click(screen.getByRole("radio", { name: /Careful/ }));
    expect((screen.getByRole("radio", { name: /Careful/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /Balanced/ }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Create Dot" }));
    await waitFor(() => expect(plane.created).toHaveLength(1));
    expect((plane.created[0] as { permissions: unknown }).permissions).toEqual({ "files.write": "ask", "computer.exec": "ask" });
  });

  it("sends the summary model, and the cost cap that was typed", async () => {
    await renderPage();
    await fillIdentity();
    await userEvent.type(screen.getByLabelText(/Summary model/), "a/summary");
    const cap = screen.getByLabelText("Spending cap per task");
    await userEvent.clear(cap);
    await userEvent.type(cap, "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Create Dot" }));
    await waitFor(() => expect(plane.created).toHaveLength(1));
    const sent = plane.created[0] as { models: unknown; limits: unknown };
    expect(sent.models).toEqual({ summary: "a/summary" });
    expect(sent.limits).toEqual({ max_cost_per_task_usd: 2.5 });
  });

  it("takes a typed number only while it is inside the range, and shows the value in force when the field is left", async () => {
    await renderPage();
    const exact = screen.getByLabelText("Memory, exact value") as HTMLInputElement;
    const slider = screen.getByLabelText("Memory") as HTMLInputElement;
    await userEvent.clear(exact);
    await userEvent.type(exact, "999");
    // "9" was in range; "99" and "999" were not, so the value stays what the last good text made it.
    expect(slider.value).toBe("9");
    await userEvent.tab();
    expect(exact.value).toBe("9");
    await userEvent.clear(exact);
    await userEvent.type(exact, "16");
    expect(slider.value).toBe("16");
    fireEvent.change(slider, { target: { value: "32" } });
    expect(exact.value).toBe("32");
  });
});

describe("Create a Dot: what is wrong", () => {
  it("does not create a Dot with no name and no goal, and lists what to fix", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Create Dot" }));
    expect(plane.created).toEqual([]);
    const summary = await screen.findByRole("alert");
    expect(summary.textContent).toContain("2 things to fix");
    expect(within(summary).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Goal").getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(summary.parentElement));
  });

  it("says a name is not valid as it is typed, and not before the person has touched it", async () => {
    await renderPage();
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBeNull();
    await userEvent.type(screen.getByLabelText("Name"), "Fare Watch");
    const name = screen.getByLabelText("Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(name.getAttribute("aria-describedby")!.split(" ").at(-1)!)!.textContent).toMatch(/lowercase letters, digits and '-'/);
    await userEvent.clear(name);
    await userEvent.type(name, "fare-watch");
    expect(name.getAttribute("aria-invalid")).toBeNull();
  });

  it("refuses a name another Dot already has", async () => {
    plane.dots = [dotRecord("d1", { name: "fares" })];
    await renderPage();
    await waitFor(() => expect(plane.requests.filter((r) => r === "GET /api/dots").length).toBeGreaterThan(0));
    await userEvent.type(screen.getByLabelText("Name"), "fares");
    await waitFor(() => expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText('A Dot named "fares" already exists')).toBeTruthy();
  });

  it("shows what the control plane answered when it refuses, and stays on the page", async () => {
    plane.failCreate = { status: 409, error: "name_taken", message: 'a Dot named "fare-watch" already exists', details: [{ path: ["name"], message: "taken meanwhile" }] };
    await renderPage();
    await fillIdentity();
    await userEvent.click(screen.getByRole("button", { name: "Create Dot" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The Dot was not created");
    expect(alert.textContent).toContain('a Dot named "fare-watch" already exists');
    expect(alert.textContent).toContain("taken meanwhile");
    expect(push).not.toHaveBeenCalled();
    // The button is back, so the person can try again.
    expect((screen.getByRole("button", { name: "Create Dot" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/** The line of the checks panel for one item, as a screen reader hears it. */
function checkLine(panel: HTMLElement, label: string): string {
  const line = within(panel).getAllByRole("listitem").find((item) => item.textContent?.startsWith(label));
  if (!line) throw new Error(`no check named ${label}`);
  return line.textContent ?? "";
}

describe("Create a Dot: before you create", () => {
  it("shows the checks of the control plane, all ready when it has a key", async () => {
    await renderPage();
    const panel = await screen.findByRole("region", { name: "Before you create" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(3));
    expect(checkLine(panel, "Control plane")).toBe("Control plane: ReadyAnswering, version 9.9.9.");
    expect(checkLine(panel, "Database")).toBe("Database: ReadyAnswering.");
    expect(checkLine(panel, "OpenRouter key")).toBe("OpenRouter key: ReadyStored.");
  });

  it("says that no key is stored, and still lets the Dot be created", async () => {
    plane.keyConfigured = false;
    await renderPage();
    const panel = await screen.findByRole("region", { name: "Before you create" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(3));
    expect(checkLine(panel, "OpenRouter key")).toMatch(/^OpenRouter key: Needs attention.*cannot answer until one is/);
    expect(checkLine(panel, "Control plane")).toContain(": Ready");
    await fillIdentity();
    await userEvent.click(screen.getByRole("button", { name: "Create Dot" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("says when the control plane does not answer, and checks again on request", async () => {
    plane.healthy = false;
    await renderPage();
    const panel = await screen.findByRole("region", { name: "Before you create" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(3));
    expect(checkLine(panel, "Control plane")).toContain(": Needs attention");
    expect(checkLine(panel, "Database")).toContain(": Not checked");
    plane.healthy = true;
    await userEvent.click(within(panel).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(checkLine(panel, "Control plane")).toContain(": Ready"));
    expect(checkLine(panel, "Database")).toContain(": Ready");
  });
});

describe("Create a Dot: the YAML editor", () => {
  const yamlBox = () => screen.getByRole("textbox", { name: "Configuration (YAML)" }) as HTMLTextAreaElement;

  it("shows the form's config, and creates the Dot from the text as edited", async () => {
    await renderPage();
    await fillIdentity();
    await userEvent.click(screen.getByRole("button", { name: "Advanced YAML" }));
    expect(yamlBox().value).toContain("name: fare-watch");
    expect(yamlBox().value).toContain("cpu: 2");
    expect(screen.getByText("The configuration is valid.")).toBeTruthy();
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace("cpu: 2", "cpu: 6") } });
    await userEvent.click(screen.getByRole("button", { name: "Create Dot" }));
    await waitFor(() => expect(plane.created).toHaveLength(1));
    expect(typeof plane.created[0]).toBe("string");
    expect(plane.created[0]).toContain("cpu: 6");
    expect(push).toHaveBeenCalledWith("/dots/created-1/chat");
  });

  it("lists what is wrong with the YAML as it is typed, and refuses to create from it", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Advanced YAML" }));
    // An empty form is already invalid: no name, no goal.
    const problems = screen.getByRole("list", { name: "Problems in the YAML" });
    expect(within(problems).getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
    await userEvent.click(screen.getByRole("button", { name: "Create Dot" }));
    expect(plane.created).toEqual([]);
  });

  it("brings the edits back into the form", async () => {
    await renderPage();
    await fillIdentity();
    await userEvent.click(screen.getByRole("button", { name: "Advanced YAML" }));
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace("cpu: 2", "cpu: 6").replace('memory: "4gb"', 'memory: "12gb"') } });
    await userEvent.click(screen.getByRole("button", { name: "Form" }));
    expect((screen.getByLabelText("Processors") as HTMLInputElement).value).toBe("6");
    expect((screen.getByLabelText("Memory") as HTMLInputElement).value).toBe("12");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("fare-watch");
  });

  it("stays in the YAML, and says why, when the text sets what the form cannot show", async () => {
    await renderPage();
    await fillIdentity();
    await userEvent.click(screen.getByRole("button", { name: "Advanced YAML" }));
    fireEvent.change(yamlBox(), { target: { value: `${yamlBox().value}memory:\n  enabled: false\n` } });
    await userEvent.click(screen.getByRole("button", { name: "Form" }));
    expect(screen.getByText("The form cannot show this")).toBeTruthy();
    expect(screen.getByText(/no controls for/)).toBeTruthy();
    expect(yamlBox().value).toContain("enabled: false");
    // Editing the text again takes the message away.
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace("enabled: false", "enabled: true") } });
    expect(screen.queryByText("The form cannot show this")).toBeNull();
  });

  it("says that permissions set in the YAML match no preset", async () => {
    await renderPage();
    await fillIdentity();
    await userEvent.click(screen.getByRole("button", { name: "Advanced YAML" }));
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace("permissions: {}", "permissions:\n  computer.exec: deny") } });
    await userEvent.click(screen.getByRole("button", { name: "Form" }));
    expect(screen.getByText(/match none of these/)).toBeTruthy();
    for (const preset of ["Careful", "Balanced", "Autonomous"]) expect((screen.getByRole("radio", { name: new RegExp(preset) }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("radio", { name: /Autonomous/ }));
    expect(screen.queryByText(/match none of these/)).toBeNull();
  });
});
