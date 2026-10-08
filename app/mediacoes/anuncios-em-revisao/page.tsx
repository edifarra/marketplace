import { ListingModerationsPage } from "../listing-moderations-page";
export const dynamic = "force-dynamic";
export default async function ReviewingListingsPage({ searchParams }: { searchParams?: Promise<{ page?: string; store?: string; marketplace?: string; search?: string }> }) {
  const urlParams = (await searchParams) ?? {};
  return <ListingModerationsPage classification="review" searchParams={urlParams} />;
}
