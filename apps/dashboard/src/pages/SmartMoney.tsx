import { Card, CardBody, CardHeader } from '@/components/ui/Card';
export function SmartMoney() {
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Smart Money</h1>
      <Card>
        <CardHeader>Wallet clusters (m3 funder-cluster dedup)</CardHeader>
        <CardBody className="text-sm text-neutral-500">
          Live wallet-cluster listing arrives when the watchlist has enough M3 data to surface a
          meaningful list. The Brain's wallet-lookup endpoint (/api/brain/wallet/:walletId)
          is available now — the LLM Review page's Autopsies browser + the Predictions detail
          are the current primary surfaces for wallet-driven behaviour.
        </CardBody>
      </Card>
    </div>
  );
}
