import { Suspense } from "react";
import { Authorize } from "./authorize";

export default function Page() {
  return (
    <Suspense fallback={<main><p>Loading the approval page.</p></main>}>
      <Authorize />
    </Suspense>
  );
}
