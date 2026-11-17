-- MOM payments follow the owner's rule for every product: only through the central payment service of IT SERVICES BY RAJAT AGARWAL
-- (the Games pattern). The public Razorpay checkout key id that the central service returns with an order is kept so a second tap
-- can open the same order again. It is the public key shown in every checkout; there is no secret here.
ALTER TABLE orders ADD COLUMN key_id TEXT;
