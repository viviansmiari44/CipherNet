import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then(res => res.json());

export function useBalances(campaignId: string) {
  const { data, error, isLoading, mutate } = useSWR(
    `/api/campaigns/${campaignId}/balances`,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 30000, // 30s
      dedupingInterval: 10000,
    }
  );

  return {
    balances: data?.balances || [],
    isLoading,
    error,
    mutate,
  };
}