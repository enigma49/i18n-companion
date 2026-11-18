import {OrderSummary} from '../../components/order-summary';

export default async function CheckoutPage() {
  return (
    <main>
      <h1>Checkout</h1>
      <p>Review your order before paying.</p>
      <OrderSummary total="$10" />
    </main>
  );
}
