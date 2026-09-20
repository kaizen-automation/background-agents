# =============================================================================
# R2 Media Storage
# =============================================================================

resource "cloudflare_r2_bucket" "media" {
  count = var.r2_media_bucket_managed ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = var.r2_media_bucket_name != "" ? var.r2_media_bucket_name : "open-inspect-media-${local.name_suffix}"
  location   = var.r2_media_location
}

locals {
  # The bucket the control plane binds: Terraform's own, or one provisioned
  # out-of-band when the deployment token has no R2 permission at all.
  r2_media_bucket_name = var.r2_media_bucket_managed ? cloudflare_r2_bucket.media[0].name : var.r2_media_bucket_name
}
