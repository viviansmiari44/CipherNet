import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then(res => res.json());

export function useJobStatus(campaignId: string) {
  const { data, error, isLoading, mutate } = useSWR(
    `/api/campaigns/${campaignId}/jobs`,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 10000,
      dedupingInterval: 5000,
    }
  );

  return {
    jobs: data || [],
    isLoading,
    error,
    mutate,
  };
}