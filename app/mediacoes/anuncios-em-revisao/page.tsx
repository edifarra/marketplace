import { ListingModerationsPage } from "../listing-moderations-page";
export const dynamic = "force-dynamic";
export default function ReviewingListingsPage({ searchParams }: { searchParams?: { page?: string; store?: string; marketplace?: string; search?: string } }) {
  return <ListingModerationsPage classification="review" searchParams={searchParams} />;
}
