'use client';

import { useEffect, useState } from "react";
import Analytics from "@/components/Analytics";

export default function Home() {
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  if (!hasMounted) {
    return null;
  }

  return (
    <div>
      <Analytics />
    </div>
  );
}
