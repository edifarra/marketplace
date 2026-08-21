import { ListingModerationsPage } from "../listing-moderations-page";
export const dynamic = "force-dynamic";
export default function FinalizedListingsPage({ searchParams }: { searchParams?: { page?: string; store?: string; marketplace?: string; search?: string } }) {
  return <ListingModerationsPage classification="final" searchParams={searchParams} />;
}
