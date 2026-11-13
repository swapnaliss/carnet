import { redirect } from "next/navigation";

// The plan lives at /plans/current (M3-04); the old path and the links to it keep working.
export default function PlanRedirect() {
  redirect("/plans/current");
}
