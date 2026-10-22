// /build.json (BuildInfo): which content version this deployment was built from. The admin polls
// it after a publish (W5 PublishStatus.liveVersion).
import type { APIRoute } from "astro";
import { snapshot, snapshotSource } from "../data/snapshot";
import { buildCommit } from "../lib/build-env";
import type { BuildInfo } from "../shared/types";

export const GET: APIRoute = () => {
  const info: BuildInfo = {
    contentVersion: snapshot.contentVersion,
    builtAt: Math.floor(Date.now() / 1000),
    commit: buildCommit,
    snapshotSource,
  };
  return new Response(JSON.stringify(info), { headers: { "Content-Type": "application/json" } });
};
