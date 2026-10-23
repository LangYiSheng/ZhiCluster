"""Atomic embedding profile discovery shared by concurrent document jobs."""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.ai.gateway import ProviderError
from app.db.models import EmbeddingProfile


def ensure_embedding_profile(db, gateway, settings) -> EmbeddingProfile:
    profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint == gateway.profile_fingerprint))
    if profile is None:
        # A nested transaction rolls back only this insertion if another
        # document creates the same provider profile at the same moment.
        try:
            with db.begin_nested():
                profile = EmbeddingProfile(
                    fingerprint=gateway.profile_fingerprint,
                    model_name=settings.embedding_model,
                    dimension=int(settings.embedding_dimension),
                    status="active",
                )
                db.add(profile)
                db.flush()
        except IntegrityError:
            profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint == gateway.profile_fingerprint))
            if profile is None:
                raise
    if profile.dimension != int(settings.embedding_dimension):
        raise ProviderError("Embedding profile 维度不兼容，需重新向量化")
    return profile
