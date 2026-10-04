-- 013_fix_image_urls.sql — point image_url at the actual image, not the metadata JSON.
--
-- The ipfsUpload helper was returning pump.fun's metadata-wrapper URI for
-- image uploads. The wrapper JSON contains the real image URL in its `image`
-- field. This updates the two test coins to the resolved image.
-- (The helper is fixed going forward; this repairs the existing rows.)

UPDATE tokens
SET image_url = 'https://ipfs.io/ipfs/bafybeiafhr3prbkfmttekvomlotrrv6bb3jzhserja6kih2bzete3yr4ty'
WHERE mint IN (
  'AkREdmsePKDvB6SSitJhQSjYSa3CZ21YFcvwB2qSKUSM',
  '7STM55wD4pN4XYj9hkHsjPWZWKNSCjKpWpbb6AbnHLiy'
);
