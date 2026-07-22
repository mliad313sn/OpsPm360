import Link from "next/link";
import { Compass } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NotFound(): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <Compass className="h-8 w-8 text-primary" aria-hidden />
          <CardTitle>Not found</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">
            This project or page does not exist — or your role does not have visibility of it.
          </p>
          <Link href="/" className="text-sm text-primary underline-offset-4 hover:underline">
            Back to dashboard
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
