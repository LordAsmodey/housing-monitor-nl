-- Source recovery alerts share the durable bot-wide outbox without fake listings.
ALTER TABLE "NotificationOutbox" ALTER COLUMN "listingId" DROP NOT NULL;
